/**
 * VeriRelease Fetch GitHub Provider
 *
 * Implements read-only GitHub API interactions using native global fetch.
 * Enforces GitHub App installation token flow, RS256 JWT generation, token caching,
 * timeouts, pagination limits, rate-limit parsing, error mapping, and strict secret redaction.
 */

import { createSign } from "node:crypto";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
  GitHubRateLimitError,
  ProviderUnavailableError,
} from "../../common/errors";
import { redactSecrets } from "../../common/redact";
import type {
  GitHubChecksSummary,
  GitHubCommitMetadata,
  GitHubPullRequestDetails,
  GitHubRepoMetadata,
  GitHubCheckRun,
  GitHubCheckStatus,
  GitHubInstallationDetails,
} from "../types";
import type { GitHubProvider, PaginationOptions } from "./github-provider.interface";

export interface FetchGitHubProviderOptions {
  baseUrl?: string;
  accessToken?: string;
  appId?: string;
  privateKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class FetchGitHubProvider implements GitHubProvider {
  private readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly appId?: string;
  private readonly privateKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  // In-memory cache for installation access tokens: installationId -> { token, expiresAt }
  private readonly tokenCache = new Map<number, { token: string; expiresAt: number }>();
  private readonly REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiration

  constructor(options?: FetchGitHubProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.accessToken = options?.accessToken;
    this.appId = options?.appId;
    this.privateKey = options?.privateKey;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.maxRetries = options?.maxRetries ?? 2;
  }

  /**
   * Clears the in-memory installation token cache (useful for testing).
   */
  clearTokenCache(): void {
    this.tokenCache.clear();
  }

  /**
   * Returns cached token entry for testing/inspection.
   */
  getCachedToken(installationId: number): { token: string; expiresAt: number } | undefined {
    return this.tokenCache.get(installationId);
  }

  /**
   * Generates a signed RS256 JWT for GitHub App authentication (valid for up to 10 minutes).
   */
  generateAppJwt(): string {
    if (!this.appId || !this.privateKey) {
      throw new DomainForbiddenError(
        "GitHub App ID and private key must be configured to generate App JWTs"
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.appId,
        iat: now - 60,
        exp: now + 600,
      })
    ).toString("base64url");

    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(this.privateKey, "base64url");
    return `${header}.${payload}.${signature}`;
  }

  /**
   * Exchanges an App JWT for a short-lived installation access token using POST /app/installations/{id}/access_tokens.
   * Caches the token with a 5-minute refresh margin before actual expiration.
   */
  async getInstallationAccessToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    const now = Date.now();
    if (cached && cached.expiresAt > now + this.REFRESH_MARGIN_MS) {
      return cached.token;
    }

    const appJwt = this.generateAppJwt();
    const authHeader = `Bearer ${appJwt}`;

    try {
      const { data } = await this.request<{
        token: string;
        expires_at: string;
        permissions?: Record<string, string>;
      }>(
        `/app/installations/${installationId}/access_tokens`,
        undefined,
        authHeader,
        "POST",
        {
          permissions: {
            pull_requests: "read",
            contents: "read",
            checks: "read",
            metadata: "read",
          },
        }
      );

      const expiresAt = new Date(data.expires_at).getTime();
      this.tokenCache.set(installationId, {
        token: data.token,
        expiresAt,
      });

      return data.token;
    } catch (err: unknown) {
      if (err instanceof DomainNotFoundError || err instanceof DomainForbiddenError) {
        throw new DomainForbiddenError(
          `GitHub App installation '${installationId}' is revoked, expired, or lacks required permissions`
        );
      }
      throw err;
    }
  }

  /**
   * Resolves the appropriate Authorization header for a repository.
   * In production, requires the GitHub App installation token flow.
   */
  private async getRepoAuthHeader(owner: string, repo: string): Promise<string | undefined> {
    if (this.appId && this.privateKey) {
      const installation = await this.getRepositoryInstallation(owner, repo);
      const token = await this.getInstallationAccessToken(installation.id);
      return `Bearer ${token}`;
    }

    // Silent fallback to personal access token is strictly prohibited in production
    if (process.env.NODE_ENV === "production") {
      throw new DomainForbiddenError(
        "Production environment requires GitHub App credentials (GITHUB_APP_ID, GITHUB_PRIVATE_KEY); personal access tokens are prohibited in production"
      );
    }

    if (this.accessToken) {
      return `Bearer ${this.accessToken}`;
    }

    // In development or unit testing without credentials, permit unauthenticated request
    return undefined;
  }

  private async request<T>(
    endpoint: string,
    params?: Record<string, string | number | undefined>,
    customAuthHeader?: string,
    method: "GET" | "POST" = "GET",
    body?: unknown
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "VeriRelease-Evidence-Ingestion/1.0",
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    if (customAuthHeader) {
      headers.Authorization = customAuthHeader;
    } else if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    let attempt = 0;
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          const data = (await response.json()) as T;
          return { data, headers: response.headers };
        }

        // Handle error statuses
        await this.handleErrorResponse(response, endpoint);
      } catch (err: unknown) {
        clearTimeout(timer);

        if (err instanceof Error && err.name === "AbortError") {
          throw new ProviderUnavailableError(
            "GitHub",
            `Request timed out after ${this.timeoutMs}ms for ${redactSecrets(endpoint)}`,
            408
          );
        }

        // Re-throw our mapped domain errors directly
        if (
          err instanceof DomainNotFoundError ||
          err instanceof DomainForbiddenError ||
          err instanceof DomainValidationError ||
          err instanceof GitHubRateLimitError ||
          err instanceof ProviderUnavailableError
        ) {
          throw err;
        }

        // Transient network retry
        if (attempt <= this.maxRetries) {
          await new Promise((res) => setTimeout(res, 200 * attempt));
          continue;
        }

        const msg = err instanceof Error ? err.message : String(err);
        throw new ProviderUnavailableError("GitHub", `Network failure: ${redactSecrets(msg)}`);
      }
    }
  }

  private async handleErrorResponse(response: Response, endpoint: string): Promise<never> {
    const status = response.status;
    let errorBody: Record<string, unknown> | null = null;

    try {
      errorBody = (await response.json()) as Record<string, unknown>;
    } catch {
      // Body may not be JSON
    }

    const rawMessage =
      typeof errorBody?.message === "string"
        ? errorBody.message
        : `GitHub API error ${status} on ${endpoint}`;
    const message = redactSecrets(rawMessage);

    // Rate Limiting: 429 Too Many Requests or 403 with rate limit headers
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");

    if (
      status === 429 ||
      (status === 403 && (remaining === "0" || message.toLowerCase().includes("rate limit")))
    ) {
      const resetDate = reset ? new Date(parseInt(reset, 10) * 1000) : undefined;
      const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
      throw new GitHubRateLimitError(message, resetDate, retrySeconds);
    }

    if (status === 404) {
      throw new DomainNotFoundError("GitHub Resource", redactSecrets(endpoint));
    }

    if (status === 401 || status === 403) {
      throw new DomainForbiddenError(`GitHub access denied for ${redactSecrets(endpoint)}: ${message}`);
    }

    if (status === 422) {
      throw new DomainValidationError(`GitHub unprocessable entity on ${redactSecrets(endpoint)}: ${message}`);
    }

    if (status >= 500) {
      throw new ProviderUnavailableError("GitHub", message, status);
    }

    throw new ProviderUnavailableError("GitHub", `Unexpected status ${status}: ${message}`, status);
  }

  async getRepositoryInstallation(owner: string, repo: string): Promise<GitHubInstallationDetails> {
    // If App credentials are provided, use App JWT; otherwise use ambient token
    let authHeader: string | undefined;
    if (this.appId && this.privateKey) {
      const appJwt = this.generateAppJwt();
      authHeader = `Bearer ${appJwt}`;
    }

    try {
      const { data } = await this.request<{
        id: number;
        account: { id: number; login: string };
        repository_selection: "all" | "selected";
      }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, undefined, authHeader);

      return {
        id: Number(data.id),
        account: {
          id: Number(data.account.id),
          login: String(data.account.login),
        },
        repositorySelection: data.repository_selection === "selected" ? "selected" : "all",
      };
    } catch (err: unknown) {
      if (err instanceof DomainNotFoundError) {
        throw new DomainForbiddenError(
          `GitHub App is not installed on repository '${owner}/${repo}' or installation was revoked`
        );
      }
      throw err;
    }
  }

  async getUserRepositoryPermission(owner: string, repo: string, username: string): Promise<string> {
    if (!username || username.trim() === "") {
      return "none";
    }

    const authHeader = await this.getRepoAuthHeader(owner, repo);

    try {
      const { data } = await this.request<{
        permission: string;
        role_name?: string;
      }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username.trim())}/permission`,
        undefined,
        authHeader
      );

      return data.permission || data.role_name || "none";
    } catch (err: unknown) {
      if (err instanceof DomainNotFoundError) {
        return "none";
      }
      throw err;
    }
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata> {
    const authHeader = await this.getRepoAuthHeader(owner, repo);
    const { data } = await this.request<Record<string, unknown>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      undefined,
      authHeader
    );

    return {
      id: Number(data.id),
      owner: (data.owner as { login: string }).login,
      name: String(data.name),
      fullName: String(data.full_name),
      isPrivate: Boolean(data.private),
      defaultBranch: String(data.default_branch || "main"),
      htmlUrl: String(data.html_url),
      description: data.description ? String(data.description) : null,
    };
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullRequestDetails> {
    const authHeader = await this.getRepoAuthHeader(owner, repo);
    const { data } = await this.request<Record<string, unknown>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
      undefined,
      authHeader
    );

    const head = (data.head ?? {}) as Record<string, unknown>;
    const base = (data.base ?? {}) as Record<string, unknown>;
    const user = (data.user ?? {}) as Record<string, unknown>;
    const headRepo = head.repo as Record<string, unknown> | null;
    const baseRepo = base.repo as Record<string, unknown> | null;

    return {
      id: Number(data.id),
      number: Number(data.number),
      title: String(data.title),
      body: data.body ? String(data.body) : null,
      state: data.state === "closed" ? "closed" : "open",
      isMerged: Boolean(data.merged_at !== null && data.merged_at !== undefined),
      mergedAt: data.merged_at ? new Date(String(data.merged_at)) : null,
      mergeCommitSha: data.merge_commit_sha ? String(data.merge_commit_sha).toLowerCase() : null,
      headSha: String(head.sha ?? "").toLowerCase(),
      headRef: String(head.ref ?? ""),
      headRepoId: headRepo?.id ? Number(headRepo.id) : null,
      baseSha: String(base.sha ?? "").toLowerCase(),
      baseRef: String(base.ref ?? ""),
      baseRepoId: baseRepo?.id ? Number(baseRepo.id) : null,
      authorUsername: String(user.login ?? ""),
      authorId: Number(user.id ?? 0),
      htmlUrl: String(data.html_url),
      createdAt: new Date(String(data.created_at)),
      updatedAt: new Date(String(data.updated_at)),
    };
  }

  async getPullRequestCommits(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: PaginationOptions
  ): Promise<GitHubCommitMetadata[]> {
    const authHeader = await this.getRepoAuthHeader(owner, repo);
    const maxPages = options?.maxPages ?? 10;
    const perPage = options?.perPage ?? 100;
    let page = options?.page ?? 1;

    const allCommits: GitHubCommitMetadata[] = [];

    while (page <= maxPages) {
      const { data } = await this.request<Array<Record<string, unknown>>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/commits`,
        { page, per_page: perPage },
        authHeader
      );

      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      for (const item of data) {
        const commit = (item.commit ?? {}) as Record<string, unknown>;
        const author = (commit.author ?? {}) as Record<string, unknown>;
        const committer = (commit.committer ?? {}) as Record<string, unknown>;
        const tree = (commit.tree ?? {}) as Record<string, unknown>;
        const parents = (Array.isArray(item.parents) ? item.parents : []) as Array<{ sha: string }>;

        allCommits.push({
          sha: String(item.sha ?? "").toLowerCase(),
          message: String(commit.message || ""),
          authorName: String(author.name || ""),
          authorEmail: String(author.email || ""),
          authoredDate: author.date ? new Date(String(author.date)) : new Date(),
          committerName: String(committer.name || ""),
          committerEmail: String(committer.email || ""),
          committedDate: committer.date ? new Date(String(committer.date)) : new Date(),
          treeSha: String(tree.sha || "").toLowerCase(),
          parents: parents.map((p) => String(p.sha || "").toLowerCase()),
        });
      }

      if (data.length < perPage) {
        break;
      }
      page++;
    }

    return allCommits;
  }

  async getCommit(owner: string, repo: string, ref: string): Promise<GitHubCommitMetadata> {
    const authHeader = await this.getRepoAuthHeader(owner, repo);
    const { data } = await this.request<Record<string, unknown>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      undefined,
      authHeader
    );

    const commit = (data.commit ?? {}) as Record<string, unknown>;
    const author = (commit.author ?? {}) as Record<string, unknown>;
    const committer = (commit.committer ?? {}) as Record<string, unknown>;
    const tree = (commit.tree ?? {}) as Record<string, unknown>;
    const parents = (Array.isArray(data.parents) ? data.parents : []) as Array<{ sha: string }>;

    return {
      sha: String(data.sha ?? "").toLowerCase(),
      message: String(commit.message || ""),
      authorName: String(author.name || ""),
      authorEmail: String(author.email || ""),
      authoredDate: author.date ? new Date(String(author.date)) : new Date(),
      committerName: String(committer.name || ""),
      committerEmail: String(committer.email || ""),
      committedDate: committer.date ? new Date(String(committer.date)) : new Date(),
      treeSha: String(tree.sha || "").toLowerCase(),
      parents: parents.map((p) => String(p.sha || "").toLowerCase()),
    };
  }

  async getPullRequestChecks(
    owner: string,
    repo: string,
    ref: string,
    options?: PaginationOptions
  ): Promise<GitHubChecksSummary> {
    const authHeader = await this.getRepoAuthHeader(owner, repo);
    const maxPages = options?.maxPages ?? 10;
    const perPage = options?.perPage ?? 100;
    let page = options?.page ?? 1;

    const allCheckRuns: GitHubCheckRun[] = [];
    let reportedTotalCount = 0;
    let isTruncated = false;

    try {
      while (page <= maxPages) {
        const { data } = await this.request<{
          total_count: number;
          check_runs: Array<Record<string, unknown>>;
        }>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs`,
          { page, per_page: perPage },
          authHeader
        );

        reportedTotalCount = data.total_count ?? 0;
        const runsOnPage = data.check_runs || [];

        for (const cr of runsOnPage) {
          const rawStatus = String(cr.status ?? "");
          const status: "queued" | "in_progress" | "completed" =
            rawStatus === "queued" || rawStatus === "in_progress" || rawStatus === "completed"
              ? rawStatus
              : "completed";

          const rawConclusion = cr.conclusion ? String(cr.conclusion) : null;
          const validConclusions = [
            "success",
            "failure",
            "neutral",
            "cancelled",
            "timed_out",
            "action_required",
            "skipped",
          ] as const;

          const conclusion =
            rawConclusion && (validConclusions as readonly string[]).includes(rawConclusion)
              ? (rawConclusion as (typeof validConclusions)[number])
              : null;

          allCheckRuns.push({
            id: Number(cr.id),
            name: String(cr.name || ""),
            status,
            conclusion,
            startedAt: cr.startedAt ? new Date(String(cr.started_at)) : null,
            completedAt: cr.completedAt ? new Date(String(cr.completed_at)) : null,
            detailsUrl: cr.details_url ? String(cr.details_url) : null,
          });
        }

        if (runsOnPage.length < perPage || allCheckRuns.length >= reportedTotalCount) {
          break;
        }

        page++;
      }

      if (reportedTotalCount > allCheckRuns.length) {
        isTruncated = true;
      }

      // Derive aggregate summary status
      let overallStatus: GitHubCheckStatus = "UNAVAILABLE";

      if (isTruncated) {
        // Incomplete/truncated check data must NEVER be converted to SUCCESS!
        // If an explicit failure is visible, report FAILURE; otherwise UNAVAILABLE.
        const hasFailure = allCheckRuns.some(
          (cr) =>
            cr.conclusion === "failure" ||
            cr.conclusion === "timed_out" ||
            cr.conclusion === "cancelled"
        );
        overallStatus = hasFailure ? "FAILURE" : "UNAVAILABLE";
      } else if (allCheckRuns.length > 0) {
        const hasFailure = allCheckRuns.some(
          (cr) =>
            cr.conclusion === "failure" ||
            cr.conclusion === "timed_out" ||
            cr.conclusion === "cancelled"
        );
        const hasPending = allCheckRuns.some(
          (cr) => cr.status !== "completed" || cr.conclusion === null
        );

        if (hasFailure) {
          overallStatus = "FAILURE";
        } else if (hasPending) {
          overallStatus = "PENDING";
        } else {
          overallStatus = "SUCCESS";
        }
      }

      return {
        status: overallStatus,
        totalCount: Math.max(reportedTotalCount, allCheckRuns.length),
        checkRuns: allCheckRuns,
      };
    } catch (err: unknown) {
      if (err instanceof DomainNotFoundError || err instanceof DomainForbiddenError) {
        return {
          status: "UNAVAILABLE",
          totalCount: 0,
          checkRuns: [],
        };
      }
      throw err;
    }
  }
}
