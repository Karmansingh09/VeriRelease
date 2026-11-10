/**
 * VeriRelease GitHub OAuth Client Boundary
 *
 * Implements the read-only OAuth 2.0 Web Application Flow client for exchanging
 * authorization codes for short-lived access tokens and fetching verified GitHub user profiles.
 */

import { DomainForbiddenError, DomainUnauthorizedError } from "../common/errors";
import { redactSecrets } from "../common/redact";
import type { GitHubOAuthUserProfile, GitHubOAuthUserEmail } from "./types";

export interface GitHubOAuthTokens {
  accessToken: string;
  tokenType: string;
  scope: string;
}

export interface GitHubOAuthClient {
  /**
   * Exchanges an authorization code for an OAuth access token.
   */
  exchangeCode(code: string, redirectUri?: string, codeVerifier?: string): Promise<GitHubOAuthTokens>;

  /**
   * Fetches the authenticated GitHub user profile.
   */
  getUserProfile(accessToken: string): Promise<GitHubOAuthUserProfile>;

  /**
   * Fetches the email addresses associated with the authenticated GitHub user.
   */
  getUserEmails(accessToken: string): Promise<GitHubOAuthUserEmail[]>;
}

export interface FetchGitHubOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  oauthBaseUrl?: string; // defaults to https://github.com
  apiBaseUrl?: string; // defaults to https://api.github.com
}

export class FetchGitHubOAuthClient implements GitHubOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly oauthBaseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(options: FetchGitHubOAuthClientOptions) {
    if (!options.clientId || options.clientId.trim() === "") {
      throw new DomainUnauthorizedError("GITHUB_OAUTH_CLIENT_ID is required for GitHub OAuth client");
    }
    if (!options.clientSecret || options.clientSecret.trim() === "") {
      throw new DomainUnauthorizedError("GITHUB_OAUTH_CLIENT_SECRET is required for GitHub OAuth client");
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.oauthBaseUrl = options.oauthBaseUrl ?? "https://github.com";
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  async exchangeCode(
    code: string,
    redirectUri?: string,
    codeVerifier?: string
  ): Promise<GitHubOAuthTokens> {
    if (!code || typeof code !== "string" || code.trim() === "") {
      throw new DomainUnauthorizedError("Cannot exchange empty or invalid OAuth authorization code");
    }

    const tokenUrl = `${this.oauthBaseUrl}/login/oauth/access_token`;
    const payload: Record<string, string> = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: code.trim(),
    };
    if (redirectUri) {
      payload.redirect_uri = redirectUri;
    }
    if (codeVerifier) {
      payload.code_verifier = codeVerifier;
    }

    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "VeriRelease-Auth",
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DomainUnauthorizedError(`Network failure during GitHub OAuth token exchange: ${redactSecrets(msg)}`);
    }

    if (!res.ok) {
      throw new DomainUnauthorizedError(
        `GitHub OAuth token endpoint returned HTTP ${res.status}`
      );
    }

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error) {
      const desc = data.error_description ? `: ${data.error_description}` : "";
      throw new DomainUnauthorizedError(`GitHub OAuth token exchange rejected: ${data.error}${desc}`);
    }

    if (!data.access_token || typeof data.access_token !== "string") {
      throw new DomainUnauthorizedError("GitHub OAuth response did not contain an access_token");
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? "bearer",
      scope: data.scope ?? "",
    };
  }

  async getUserProfile(accessToken: string): Promise<GitHubOAuthUserProfile> {
    if (!accessToken || typeof accessToken !== "string") {
      throw new DomainUnauthorizedError("Missing or invalid GitHub OAuth access token");
    }

    const userUrl = `${this.apiBaseUrl}/user`;
    let res: Response;
    try {
      res = await fetch(userUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "VeriRelease-Auth",
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DomainUnauthorizedError(`Failed to fetch GitHub user profile: ${redactSecrets(msg)}`);
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new DomainUnauthorizedError("Invalid or expired GitHub OAuth access token");
      }
      throw new DomainUnauthorizedError(`GitHub user endpoint returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      id?: number;
      login?: string;
      name?: string | null;
      email?: string | null;
      avatar_url?: string | null;
    };

    if (!data.id || !data.login) {
      throw new DomainForbiddenError("GitHub user profile response missing required id or login");
    }

    return {
      id: data.id,
      login: data.login,
      name: data.name ?? null,
      email: data.email ?? null,
      avatarUrl: data.avatar_url ?? null,
    };
  }

  async getUserEmails(accessToken: string): Promise<GitHubOAuthUserEmail[]> {
    if (!accessToken || typeof accessToken !== "string") {
      return [];
    }

    const emailsUrl = `${this.apiBaseUrl}/user/emails`;
    let res: Response;
    try {
      res = await fetch(emailsUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "VeriRelease-Auth",
        },
      });
    } catch {
      return [];
    }

    if (!res.ok) {
      return [];
    }

    try {
      const list = (await res.json()) as Array<{
        email?: string;
        primary?: boolean;
        verified?: boolean;
        visibility?: string | null;
      }>;

      if (!Array.isArray(list)) {
        return [];
      }

      return list
        .filter((item) => typeof item.email === "string" && item.email.length > 0)
        .map((item) => ({
          email: item.email as string,
          primary: Boolean(item.primary),
          verified: Boolean(item.verified),
          visibility: item.visibility ?? null,
        }));
    } catch {
      return [];
    }
  }
}
