import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { FetchGitHubProvider } from "../../src/modules/github/provider/fetch-github-provider";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
  GitHubRateLimitError,
  ProviderUnavailableError,
} from "../../src/modules/common/errors";

describe("FetchGitHubProvider Unit Test Suite", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("successfully fetches and normalizes repository metadata", async () => {
    const mockRepoResponse = {
      id: 12345678,
      name: "veri-test",
      full_name: "acme/veri-test",
      private: false,
      owner: { login: "acme" },
      default_branch: "main",
      html_url: "https://github.com/acme/veri-test",
      description: "Test repository",
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mockRepoResponse,
    } as Response);

    const provider = new FetchGitHubProvider({ accessToken: "ghp_secret_token_12345" });
    const repo = await provider.getRepository("acme", "veri-test");

    expect(repo.id).toBe(12345678);
    expect(repo.owner).toBe("acme");
    expect(repo.name).toBe("veri-test");
    expect(repo.fullName).toBe("acme/veri-test");
    expect(repo.isPrivate).toBe(false);
    expect(repo.defaultBranch).toBe("main");
  });

  it("successfully fetches and normalizes pull request details", async () => {
    const mockPrResponse = {
      id: 998877,
      number: 42,
      title: "Add verification module",
      body: "Implements feature X",
      state: "open",
      merged_at: null,
      merge_commit_sha: null,
      head: {
        sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        ref: "feature-branch",
        repo: { id: 12345678 },
      },
      base: {
        sha: "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
        ref: "main",
        repo: { id: 12345678 },
      },
      user: { login: "developer-bob", id: 54321 },
      html_url: "https://github.com/acme/veri-test/pull/42",
      created_at: "2026-11-01T10:00:00Z",
      updated_at: "2026-11-02T12:00:00Z",
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mockPrResponse,
    } as Response);

    const provider = new FetchGitHubProvider();
    const pr = await provider.getPullRequest("acme", "veri-test", 42);

    expect(pr.number).toBe(42);
    expect(pr.title).toBe("Add verification module");
    expect(pr.state).toBe("open");
    expect(pr.isMerged).toBe(false);
    expect(pr.headSha).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
    expect(pr.baseSha).toBe("f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5");
    expect(pr.authorUsername).toBe("developer-bob");
  });

  it("handles pagination of pull request commits up to maxPages", async () => {
    const page1Commits = [
      {
        sha: "1".repeat(40),
        commit: {
          message: "First commit",
          author: { name: "Alice", email: "alice@test.com", date: "2026-11-01T00:00:00Z" },
          committer: { name: "Alice", email: "alice@test.com", date: "2026-11-01T00:00:00Z" },
          tree: { sha: "a".repeat(40) },
        },
        parents: [],
      },
      {
        sha: "2".repeat(40),
        commit: {
          message: "Second commit",
          author: { name: "Alice", email: "alice@test.com", date: "2026-11-01T01:00:00Z" },
          committer: { name: "Alice", email: "alice@test.com", date: "2026-11-01T01:00:00Z" },
          tree: { sha: "b".repeat(40) },
        },
        parents: [{ sha: "1".repeat(40) }],
      },
    ];

    const page2Commits = [
      {
        sha: "3".repeat(40),
        commit: {
          message: "Third commit",
          author: { name: "Alice", email: "alice@test.com", date: "2026-11-01T02:00:00Z" },
          committer: { name: "Alice", email: "alice@test.com", date: "2026-11-01T02:00:00Z" },
          tree: { sha: "c".repeat(40) },
        },
        parents: [{ sha: "2".repeat(40) }],
      },
    ];

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      const parsedUrl = new URL(url);
      const page = parsedUrl.searchParams.get("page");
      const data = page === "2" ? page2Commits : page1Commits;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => data,
      } as Response;
    });

    const provider = new FetchGitHubProvider();
    const commits = await provider.getPullRequestCommits("acme", "veri-test", 42, {
      perPage: 2,
      maxPages: 5,
    });

    expect(commits.length).toBe(3);
    expect(commits[0]?.sha).toBe("1".repeat(40));
    expect(commits[2]?.sha).toBe("3".repeat(40));
    expect(callCount).toBe(2);
  });

  it("correctly derives checks summary: SUCCESS when all completed check runs pass", async () => {
    const mockChecksResponse = {
      total_count: 2,
      check_runs: [
        { id: 1, name: "test", status: "completed", conclusion: "success" },
        { id: 2, name: "lint", status: "completed", conclusion: "success" },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mockChecksResponse,
    } as Response);

    const provider = new FetchGitHubProvider();
    const summary = await provider.getPullRequestChecks("acme", "veri-test", "sha123");

    expect(summary.status).toBe("SUCCESS");
    expect(summary.totalCount).toBe(2);
    expect(summary.checkRuns.length).toBe(2);
  });

  it("correctly derives checks summary: FAILURE when any run failed", async () => {
    const mockChecksResponse = {
      total_count: 2,
      check_runs: [
        { id: 1, name: "test", status: "completed", conclusion: "failure" },
        { id: 2, name: "lint", status: "completed", conclusion: "success" },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mockChecksResponse,
    } as Response);

    const provider = new FetchGitHubProvider();
    const summary = await provider.getPullRequestChecks("acme", "veri-test", "sha123");

    expect(summary.status).toBe("FAILURE");
  });

  it("correctly derives checks summary: PENDING when any run is in progress", async () => {
    const mockChecksResponse = {
      total_count: 2,
      check_runs: [
        { id: 1, name: "test", status: "in_progress", conclusion: null },
        { id: 2, name: "lint", status: "completed", conclusion: "success" },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mockChecksResponse,
    } as Response);

    const provider = new FetchGitHubProvider();
    const summary = await provider.getPullRequestChecks("acme", "veri-test", "sha123");

    expect(summary.status).toBe("PENDING");
  });

  it("handles complete pagination for check runs with >30 items, detecting failure on page 2", async () => {
    // 35 total runs: Page 1 has 30 successful runs; Page 2 has 5 runs including 1 failure
    const page1Runs = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `ci-check-${i + 1}`,
      status: "completed",
      conclusion: "success",
    }));

    const page2Runs = [
      { id: 31, name: "ci-check-31", status: "completed", conclusion: "success" },
      { id: 32, name: "ci-check-32", status: "completed", conclusion: "failure" }, // Failing on page 2!
      { id: 33, name: "ci-check-33", status: "completed", conclusion: "success" },
      { id: 34, name: "ci-check-34", status: "completed", conclusion: "success" },
      { id: 35, name: "ci-check-35", status: "completed", conclusion: "success" },
    ];

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const parsedUrl = new URL(url);
      const page = parsedUrl.searchParams.get("page") ?? "1";
      const runs = page === "2" ? page2Runs : page1Runs;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          total_count: 35,
          check_runs: runs,
        }),
      } as Response;
    });

    const provider = new FetchGitHubProvider();
    const summary = await provider.getPullRequestChecks("acme", "veri-test", "sha123", {
      perPage: 30,
      maxPages: 5,
    });

    expect(summary.totalCount).toBe(35);
    expect(summary.checkRuns.length).toBe(35);
    // Verified: If pagination was missing, failure on page 2 would be omitted and marked SUCCESS!
    expect(summary.status).toBe("FAILURE");
  });

  it("never converts truncated or incomplete check data into SUCCESS", async () => {
    // 150 total checks, but maxPages is 1 with perPage 100 -> truncated!
    const page1Runs = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `ci-check-${i + 1}`,
      status: "completed",
      conclusion: "success",
    }));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        total_count: 150,
        check_runs: page1Runs,
      }),
    } as Response);

    const provider = new FetchGitHubProvider();
    const summary = await provider.getPullRequestChecks("acme", "veri-test", "sha123", {
      perPage: 100,
      maxPages: 1, // Will truncate remaining 50 checks
    });

    expect(summary.totalCount).toBe(150);
    expect(summary.checkRuns.length).toBe(100);
    // Crucial rule: truncated check run list must NEVER be reported as SUCCESS
    expect(summary.status).toBe("UNAVAILABLE");
  });

  it("correctly maps 429 response to GitHubRateLimitError with parsed Retry-After", async () => {
    const headers = new Headers();
    headers.set("retry-after", "120");

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers,
      json: async () => ({ message: "Too many requests" }),
    } as Response);

    const provider = new FetchGitHubProvider();
    try {
      await provider.getRepository("acme", "repo");
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(120);
    }
  });

  it("correctly maps 404 response to DomainNotFoundError", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ message: "Not Found" }),
    } as Response);

    const provider = new FetchGitHubProvider();
    await expect(provider.getRepository("acme", "nonexistent")).rejects.toThrow(DomainNotFoundError);
  });

  it("correctly maps 403 rate limit to GitHubRateLimitError", async () => {
    const headers = new Headers();
    headers.set("x-ratelimit-remaining", "0");
    headers.set("x-ratelimit-reset", "1762780000");

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers,
      json: async () => ({ message: "API rate limit exceeded" }),
    } as Response);

    const provider = new FetchGitHubProvider();
    await expect(provider.getRepository("acme", "repo")).rejects.toThrow(GitHubRateLimitError);
  });

  it("correctly maps 401 response to DomainForbiddenError", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ message: "Bad credentials" }),
    } as Response);

    const provider = new FetchGitHubProvider();
    await expect(provider.getRepository("acme", "repo")).rejects.toThrow(DomainForbiddenError);
  });

  it("correctly maps 422 response to DomainValidationError", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      headers: new Headers(),
      json: async () => ({ message: "Validation failed" }),
    } as Response);

    const provider = new FetchGitHubProvider();
    await expect(provider.getRepository("acme", "repo")).rejects.toThrow(DomainValidationError);
  });

  it("resolves GitHub App installation successfully and rejects when App is not installed (404)", async () => {
    // 1. Success case
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 777123,
        account: { id: 101, login: "acme" },
        repository_selection: "selected",
      }),
    } as Response);

    const provider = new FetchGitHubProvider({ accessToken: "test_token" });
    const installation = await provider.getRepositoryInstallation("acme", "veri-test");
    expect(installation.id).toBe(777123);
    expect(installation.account.login).toBe("acme");
    expect(installation.repositorySelection).toBe("selected");

    // 2. 404 Not Found -> DomainForbiddenError (App not installed)
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ message: "Not Found" }),
    } as Response);

    await expect(provider.getRepositoryInstallation("acme", "unauthorized-repo")).rejects.toThrow(
      DomainForbiddenError
    );
  });

  it("secret redaction: verified that Authorization token and private keys are never present in error messages", async () => {
    const sensitiveToken = "ghp_ultra_secret_super_token_99999";
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({ message: `Internal server crash with ${sensitiveToken}` }),
    } as Response);

    const provider = new FetchGitHubProvider({ accessToken: sensitiveToken, maxRetries: 0 });
    try {
      await provider.getRepository("acme", "repo");
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ProviderUnavailableError);
      const errMsg = (err as Error).message;
      expect(errMsg).not.toContain(sensitiveToken);
      expect(errMsg).toContain("[REDACTED_GITHUB_TOKEN]");
    }
  });

  describe("GitHub App Installation Token Flow & Lifecycle", () => {
    // Generate valid 2048-bit RSA key for testing
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const testPrivateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const testAppId = "app_test_12345";
    const testInstallationId = 998877;

    it("generates a valid RS256 App JWT with iss, iat, and exp", () => {
      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      const jwt = provider.generateAppJwt();
      const parts = jwt.split(".");
      expect(parts.length).toBe(3);

      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");

      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      expect(payload.iss).toBe(testAppId);
      expect(payload.exp).toBeGreaterThan(payload.iat);
      expect(payload.exp - payload.iat).toBe(660); // 10 minutes + 60s skew allowance
    });

    it("exchanges App JWT for installation access token using POST /app/installations/:id/access_tokens", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedAuthHeader = "";
      let capturedBody: any = null;

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "GET";
        capturedAuthHeader = (init?.headers as Record<string, string>)?.Authorization ?? "";
        capturedBody = init?.body ? JSON.parse(init.body as string) : null;

        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => ({
            token: "ghs_installation_access_token_mock_001",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { pull_requests: "read", contents: "read", checks: "read" },
          }),
        } as Response;
      });

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      const token = await provider.getInstallationAccessToken(testInstallationId);

      expect(token).toBe("ghs_installation_access_token_mock_001");
      expect(capturedUrl).toContain(`/app/installations/${testInstallationId}/access_tokens`);
      expect(capturedMethod).toBe("POST");
      expect(capturedAuthHeader).toMatch(/^Bearer ey/); // Signed App JWT
      expect(capturedBody?.permissions?.pull_requests).toBe("read");
    });

    it("caches installation access token and avoids repeated exchange requests", async () => {
      let exchangeCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        exchangeCount++;
        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => ({
            token: "ghs_cached_token_001",
            expires_at: new Date(Date.now() + 3600_000).toISOString(), // Valid for 1 hour
          }),
        } as Response;
      });

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      const token1 = await provider.getInstallationAccessToken(testInstallationId);
      const token2 = await provider.getInstallationAccessToken(testInstallationId);

      expect(token1).toBe("ghs_cached_token_001");
      expect(token2).toBe("ghs_cached_token_001");
      expect(exchangeCount).toBe(1); // Cached! Only 1 HTTP call made
    });

    it("refreshes installation access token when cached token is near expiry (within 5-minute margin)", async () => {
      let callCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => ({
            token: `ghs_token_version_${callCount}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
        } as Response;
      });

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      // Seed cache with a token that expires in 2 minutes (within the 5-minute refresh margin)
      const token1 = await provider.getInstallationAccessToken(testInstallationId);
      expect(token1).toBe("ghs_token_version_1");

      // Simulate token close to expiration by manually altering cached expiresAt
      const cached = provider.getCachedToken(testInstallationId)!;
      cached.expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes remaining (< 5m margin)

      // Next call must refresh
      const token2 = await provider.getInstallationAccessToken(testInstallationId);
      expect(token2).toBe("ghs_token_version_2");
      expect(callCount).toBe(2);
    });

    it("handles revoked or nonexistent installation by throwing DomainForbiddenError", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ message: "Not Found" }),
      } as Response);

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      await expect(provider.getInstallationAccessToken(999999)).rejects.toThrow(
        DomainForbiddenError
      );
      await expect(provider.getInstallationAccessToken(999999)).rejects.toThrow(
        /revoked, expired, or lacks required permissions/i
      );
    });

    it("handles insufficient installation permissions (403) by throwing DomainForbiddenError", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: new Headers(),
        json: async () => ({ message: "Resource not accessible by integration" }),
      } as Response);

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      await expect(provider.getInstallationAccessToken(testInstallationId)).rejects.toThrow(
        DomainForbiddenError
      );
    });

    it("reads private repository using installation credentials", async () => {
      // Sequence:
      // 1. GET /repos/acme/secret-repo/installation -> returns installation
      // 2. POST /app/installations/777/access_tokens -> returns installation token
      // 3. GET /repos/acme/secret-repo -> returns repo metadata
      let authHeaderOnRepoGet = "";

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/access_tokens")) {
          return {
            ok: true,
            status: 201,
            headers: new Headers(),
            json: async () => ({
              token: "ghs_private_repo_token_999",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
          } as Response;
        }

        if (url.endsWith("/installation")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              id: 777,
              account: { id: 10, login: "acme" },
              repository_selection: "selected",
            }),
          } as Response;
        }

        if (url.endsWith("/repos/acme/secret-repo")) {
          authHeaderOnRepoGet = (init?.headers as Record<string, string>)?.Authorization ?? "";
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              id: 554433,
              owner: { login: "acme" },
              name: "secret-repo",
              full_name: "acme/secret-repo",
              private: true,
              default_branch: "main",
              html_url: "https://github.com/acme/secret-repo",
              description: "Confidential repository",
            }),
          } as Response;
        }

        throw new Error(`Unexpected request URL: ${url}`);
      });

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      const repo = await provider.getRepository("acme", "secret-repo");

      expect(repo.fullName).toBe("acme/secret-repo");
      expect(repo.isPrivate).toBe(true);
      expect(authHeaderOnRepoGet).toBe("Bearer ghs_private_repo_token_999");
    });

    it("verifies user repository permission via installation token", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/access_tokens")) {
          return {
            ok: true,
            status: 201,
            headers: new Headers(),
            json: async () => ({
              token: "ghs_permission_check_token",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
          } as Response;
        }

        if (url.endsWith("/installation")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              id: 777,
              account: { id: 10, login: "acme" },
              repository_selection: "selected",
            }),
          } as Response;
        }

        if (url.includes("/collaborators/alice/permission")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              permission: "admin",
              role_name: "admin",
            }),
          } as Response;
        }

        if (url.includes("/collaborators/mallory/permission")) {
          return {
            ok: false,
            status: 404,
            headers: new Headers(),
            json: async () => ({ message: "Not a collaborator" }),
          } as Response;
        }

        throw new Error(`Unexpected request URL: ${url}`);
      });

      const provider = new FetchGitHubProvider({
        appId: testAppId,
        privateKey: testPrivateKeyPem,
      });

      const alicePermission = await provider.getUserRepositoryPermission("acme", "repo", "alice");
      expect(alicePermission).toBe("admin");

      const malloryPermission = await provider.getUserRepositoryPermission("acme", "repo", "mallory");
      expect(malloryPermission).toBe("none");
    });

    it("prohibits silent fallback to personal access token in production", async () => {
      vi.stubEnv("NODE_ENV", "production");

      try {
        const provider = new FetchGitHubProvider({
          accessToken: "ghp_static_token_not_allowed_in_prod",
        });

        await expect(provider.getRepository("acme", "repo")).rejects.toThrow(DomainForbiddenError);
        await expect(provider.getRepository("acme", "repo")).rejects.toThrow(
          /personal access tokens are prohibited in production/i
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
