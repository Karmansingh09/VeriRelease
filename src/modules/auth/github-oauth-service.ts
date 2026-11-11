/**
 * VeriRelease GitHub OAuth Service
 *
 * Implements the secure GitHub OAuth 2.0 Web Application Flow, cryptographic state
 * generation and constant-time verification, verified identity linking to VeriRelease users,
 * and secure HTTP-only session cookie generation.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { prisma, type DbClient } from "../../lib/prisma";
import { env } from "../../lib/env";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../common/errors";
import { TransactionalAuditService, type AuditService } from "../audit";
import { authService as defaultAuthService, AuthService, DEFAULT_TOKEN_TTL_SECONDS } from "./auth-service";
import {
  FetchGitHubOAuthClient,
  type GitHubOAuthClient,
} from "./github-oauth-client";
import {
  type AuthenticatedUser,
  type OAuthStatePayload,
  type OAuthTransactionStore,
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_MAX_AGE_SECONDS,
} from "./types";
import { PrismaOAuthTransactionStore } from "./oauth-transaction-store";

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  signingSecret: string;
  isProduction?: boolean;
}

export interface GenerateAuthUrlOptions {
  action?: "login" | "link";
  authenticatedUserId?: string;
  returnTo?: string;
}

export interface GenerateAuthUrlResult {
  authorizationUrl: string;
  stateToken: string;
  cookieHeader: string;
}

export interface HandleCallbackParams {
  code?: string | null;
  state?: string | null;
  cookieState?: string | null;
  currentAuthenticatedUser?: AuthenticatedUser | null;
  error?: string | null;
  errorDescription?: string | null;
}

export interface HandleCallbackResult {
  user: AuthenticatedUser;
  sessionToken: string;
  returnTo: string;
  clearStateCookieHeader: string;
  sessionCookieHeader: string;
}

export class GitHubOAuthService {
  private readonly config: GitHubOAuthConfig;
  private readonly client: DbClient;
  private readonly authService: AuthService;
  private readonly oauthClient: GitHubOAuthClient;
  private readonly auditService: AuditService;
  private readonly transactionStore: OAuthTransactionStore;

  constructor(
    config?: Partial<GitHubOAuthConfig>,
    options?: {
      client?: DbClient;
      authService?: AuthService;
      oauthClient?: GitHubOAuthClient;
      auditService?: AuditService;
      transactionStore?: OAuthTransactionStore;
    }
  ) {
    this.config = {
      clientId: config?.clientId ?? env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: config?.clientSecret ?? env.GITHUB_OAUTH_CLIENT_SECRET,
      callbackUrl: config?.callbackUrl ?? env.GITHUB_OAUTH_CALLBACK_URL,
      signingSecret: config?.signingSecret ?? env.AUTH_TOKEN_SIGNING_SECRET,
      isProduction: config?.isProduction ?? env.NODE_ENV === "production",
    };

    if (!this.config.clientId || this.config.clientId.trim() === "") {
      throw new DomainUnauthorizedError("GITHUB_OAUTH_CLIENT_ID is required for GitHub OAuth service");
    }
    if (!this.config.clientSecret || this.config.clientSecret.trim() === "") {
      throw new DomainUnauthorizedError("GITHUB_OAUTH_CLIENT_SECRET is required for GitHub OAuth service");
    }
    if (!this.config.callbackUrl || this.config.callbackUrl.trim() === "") {
      throw new DomainUnauthorizedError("GITHUB_OAUTH_CALLBACK_URL is required for GitHub OAuth service");
    }
    if (!this.config.signingSecret || this.config.signingSecret.trim().length < 16) {
      throw new DomainUnauthorizedError("AUTH_TOKEN_SIGNING_SECRET is required and must be >= 16 characters");
    }

    this.client = options?.client ?? prisma;
    this.authService = options?.authService ?? defaultAuthService;
    this.auditService = options?.auditService ?? new TransactionalAuditService();
    this.transactionStore =
      options?.transactionStore ?? new PrismaOAuthTransactionStore(this.client);
    this.oauthClient =
      options?.oauthClient ??
      new FetchGitHubOAuthClient({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      });
  }

  /**
   * Builds an RFC 6265 compliant Set-Cookie header string.
   */
  buildCookieHeader(
    name: string,
    value: string,
    options: {
      maxAge: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Lax" | "Strict" | "None";
      path?: string;
    }
  ): string {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${options.path ?? "/"}`);
    if (options.maxAge >= 0) {
      parts.push(`Max-Age=${options.maxAge}`);
      const expires = new Date(Date.now() + options.maxAge * 1000).toUTCString();
      parts.push(`Expires=${expires}`);
    } else {
      parts.push("Max-Age=0");
      parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
    if (options.httpOnly ?? true) {
      parts.push("HttpOnly");
    }
    if (options.secure ?? this.config.isProduction) {
      parts.push("Secure");
    }
    parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
    return parts.join("; ");
  }

  /**
   * Builds a Set-Cookie header string that immediately clears the specified cookie.
   */
  clearCookieHeader(name: string): string {
    return this.buildCookieHeader(name, "", {
      maxAge: -1,
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: "Lax",
      path: "/",
    });
  }

  /**
   * Generates a signed, tamper-proof state token and authorization URL.
   * Confidentially stores the PKCE code_verifier server-side in the transaction store.
   */
  async generateAuthorizationUrl(options?: GenerateAuthUrlOptions): Promise<GenerateAuthUrlResult> {
    const action = options?.action ?? (options?.authenticatedUserId ? "link" : "login");

    // Enforce that account linking MUST have an authenticated user ID
    if (action === "link" && (!options?.authenticatedUserId || options.authenticatedUserId.trim() === "")) {
      throw new DomainUnauthorizedError("Cannot initiate GitHub account linking without an authenticated user session");
    }

    // A login action MUST NOT contain a target user ID
    if (action === "login" && options?.authenticatedUserId) {
      throw new DomainValidationError("Login state must not include a target user ID");
    }

    const targetUserId = action === "link" ? options?.authenticatedUserId : undefined;

    // Sanitize returnTo to prevent open redirects
    let returnTo = "/";
    if (options?.returnTo && typeof options.returnTo === "string") {
      const trimmed = options.returnTo.trim();
      if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
        returnTo = trimmed;
      }
    }

    // RFC 7636 PKCE S256 code verifier and code challenge
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const stateNonce = randomBytes(32).toString("hex");

    const expiresAt = new Date(Date.now() + OAUTH_STATE_MAX_AGE_SECONDS * 1000);

    // CONFIDENTIALITY REQUIREMENT: Store verifier strictly server-side in transaction store
    await this.transactionStore.create({
      stateNonce,
      codeVerifier,
      action,
      userId: targetUserId ?? null,
      returnTo,
      expiresAt,
    });

    // The state payload MUST NOT contain the codeVerifier
    const payload: OAuthStatePayload = {
      nonce: stateNonce,
      action,
      ...(targetUserId ? { userId: targetUserId } : {}),
      returnTo,
      createdAt: Date.now(),
    };

    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.config.signingSecret)
      .update(encodedPayload)
      .digest("base64url");

    const stateToken = `vr_state.${encodedPayload}.${signature}`;

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope: "read:user,user:email",
      state: stateToken,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      allow_signup: "true",
    });

    const authorizationUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    const cookieHeader = this.buildCookieHeader(OAUTH_STATE_COOKIE_NAME, stateToken, {
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: "Lax",
      path: "/",
    });

    return {
      authorizationUrl,
      stateToken,
      cookieHeader,
    };
  }

  /**
   * Verifies and decodes an OAuth state token.
   */
  verifyStateToken(stateToken: string): OAuthStatePayload {
    if (!stateToken || typeof stateToken !== "string" || !stateToken.startsWith("vr_state.")) {
      throw new DomainUnauthorizedError("Invalid or missing OAuth state token format");
    }

    const parts = stateToken.slice("vr_state.".length).split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new DomainUnauthorizedError("Malformed OAuth state token");
    }

    const encodedPayload = parts[0];
    const providedSig = parts[1];
    const expectedSig = createHmac("sha256", this.config.signingSecret)
      .update(encodedPayload)
      .digest("base64url");

    const bufProvided = Buffer.from(providedSig, "utf8");
    const bufExpected = Buffer.from(expectedSig, "utf8");

    if (bufProvided.length !== bufExpected.length || !timingSafeEqual(bufProvided, bufExpected)) {
      throw new DomainUnauthorizedError("OAuth state signature verification failed");
    }

    let payload: OAuthStatePayload;
    try {
      const decodedJson = Buffer.from(encodedPayload, "base64url").toString("utf8");
      payload = JSON.parse(decodedJson) as OAuthStatePayload;
    } catch {
      throw new DomainUnauthorizedError("Malformed OAuth state payload");
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.nonce !== "string" ||
      payload.nonce.trim() === "" ||
      (payload.action !== "login" && payload.action !== "link") ||
      typeof payload.createdAt !== "number"
    ) {
      throw new DomainUnauthorizedError("OAuth state payload has invalid schema or fields");
    }

    const ageMs = Date.now() - payload.createdAt;
    if (ageMs < 0 || ageMs > OAUTH_STATE_MAX_AGE_SECONDS * 1000) {
      throw new DomainUnauthorizedError("OAuth state token has expired");
    }

    return payload;
  }

  /**
   * Handles the OAuth callback: verifies state, exchanges code for access token,
   * fetches verified GitHub profile and emails, binds the verified identity,
   * and issues a VeriRelease session.
   */
  async handleCallback(params: HandleCallbackParams): Promise<HandleCallbackResult> {
    const clearStateCookieHeader = this.clearCookieHeader(OAUTH_STATE_COOKIE_NAME);

    // 1. Check for incoming OAuth errors from GitHub
    if (params.error) {
      const desc = params.errorDescription ? `: ${params.errorDescription}` : "";
      throw new DomainUnauthorizedError(`GitHub OAuth authorization rejected: ${params.error}${desc}`);
    }

    // 2. Validate presence of code and state
    if (!params.code || typeof params.code !== "string" || params.code.trim() === "") {
      throw new DomainValidationError("Missing or invalid authorization code from GitHub callback");
    }
    if (!params.state || typeof params.state !== "string" || params.state.trim() === "") {
      throw new DomainValidationError("Missing or invalid state parameter from GitHub callback");
    }

    // 3. Validate presence of state cookie
    if (!params.cookieState || typeof params.cookieState !== "string" || params.cookieState.trim() === "") {
      throw new DomainUnauthorizedError(
        "Missing OAuth state cookie. The authorization session may have expired or cookies were not preserved across redirects."
      );
    }

    // 4. Verify state parameter against state cookie using constant-time comparison
    const bufParam = Buffer.from(params.state, "utf8");
    const bufCookie = Buffer.from(params.cookieState, "utf8");
    if (bufParam.length !== bufCookie.length || !timingSafeEqual(bufParam, bufCookie)) {
      throw new DomainUnauthorizedError("OAuth state parameter does not match the state cookie");
    }

    // 5. Verify cryptographic signature and expiration of state
    const statePayload = this.verifyStateToken(params.state);

    // Fail-fast validation of session binding and state payload constraints before external network calls
    if (statePayload.action === "link") {
      if (!params.currentAuthenticatedUser) {
        throw new DomainUnauthorizedError(
          "Active authenticated session required to complete GitHub account linking"
        );
      }
      if (!statePayload.userId) {
        throw new DomainUnauthorizedError("Cannot link GitHub account: missing target user in state");
      }
      if (params.currentAuthenticatedUser.id !== statePayload.userId) {
        throw new DomainForbiddenError(
          "Account linking session mismatch: current session user does not match the initiating user"
        );
      }
    } else if (statePayload.action === "login") {
      if (statePayload.userId) {
        throw new DomainValidationError("Login state must not include a target user ID");
      }
    }

    // 6. Confidentially retrieve verifier from server-side transaction store and atomically consume transaction
    const oauthTx = await this.transactionStore.consume(statePayload.nonce, new Date());

    if (oauthTx.action !== statePayload.action) {
      throw new DomainUnauthorizedError("OAuth transaction action mismatch");
    }
    if (oauthTx.userId !== (statePayload.userId ?? null)) {
      throw new DomainUnauthorizedError("OAuth transaction user ID mismatch");
    }

    // 7. Exchange authorization code for short-lived access token using PKCE code_verifier from the server-side store
    const tokenResult = await this.oauthClient.exchangeCode(
      params.code,
      this.config.callbackUrl,
      oauthTx.codeVerifier
    );

    // 7. Fetch verified GitHub user profile
    const profile = await this.oauthClient.getUserProfile(tokenResult.accessToken);

    // 8. Fetch verified email address
    let verifiedEmail = profile.email;
    if (!verifiedEmail) {
      const emails = await this.oauthClient.getUserEmails(tokenResult.accessToken);
      const primaryVerified = emails.find((e) => e.primary && e.verified);
      verifiedEmail = primaryVerified?.email ?? null;
    }

    if (!verifiedEmail || verifiedEmail.trim() === "") {
      throw new DomainForbiddenError(
        "GitHub account does not have a verified primary email address. A verified email is required for VeriRelease authentication."
      );
    }

    // 9. Identity Binding & Resolution
    let resolvedUser: AuthenticatedUser;

    // Check if another user already has this GitHub username or GitHub ID
    const conflictingUser = await this.client.user.findFirst({
      where: {
        OR: [
          { githubUsername: { equals: profile.login, mode: "insensitive" } },
          { githubId: String(profile.id) },
        ],
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        githubUsername: true,
        githubId: true,
        isActive: true,
        suspendedAt: true,
        tokenVersion: true,
      },
    });

    if (statePayload.action === "link") {
      // 1. Require active authenticated session on callback
      if (!params.currentAuthenticatedUser) {
        throw new DomainUnauthorizedError(
          "Active authenticated session required to complete GitHub account linking"
        );
      }

      // 2. The session user must be the EXACT user who initiated the flow
      if (params.currentAuthenticatedUser.id !== statePayload.userId) {
        throw new DomainForbiddenError(
          "Account linking session mismatch: current session user does not match the initiating user"
        );
      }

      const targetUserId = statePayload.userId;
      if (!targetUserId) {
        throw new DomainUnauthorizedError("Cannot link GitHub account: missing target user in state");
      }

      const targetUser = await this.client.user.findUnique({
        where: { id: targetUserId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          githubUsername: true,
          githubId: true,
          isActive: true,
          suspendedAt: true,
          tokenVersion: true,
        },
      });

      if (!targetUser) {
        throw new DomainUnauthorizedError(`Target user '${targetUserId}' for GitHub identity linking no longer exists`);
      }

      if (!targetUser.isActive || targetUser.suspendedAt !== null) {
        throw new DomainUnauthorizedError(`Target user account '${targetUser.id}' is inactive or suspended`);
      }

      // 3. Reject if the session tokenVersion is older than current database tokenVersion (revoked session)
      if (params.currentAuthenticatedUser.tokenVersion < targetUser.tokenVersion) {
        throw new DomainUnauthorizedError(
          `Authentication session for user '${targetUser.id}' has been revoked via token version increment`
        );
      }

      // 4. Do not silently overwrite an existing linked GitHub identity
      if (targetUser.githubId && targetUser.githubId !== String(profile.id)) {
        throw new DomainConflictError(
          `User account is already linked to a different GitHub account ('${targetUser.githubUsername || targetUser.githubId}'). Unlink the existing account first before linking a new one.`
        );
      }

      // 5. Never allow a user to claim another person's GitHub identity
      if (conflictingUser && conflictingUser.id !== targetUser.id) {
        throw new DomainConflictError(
          `GitHub account '${profile.login}' is already linked to another VeriRelease user`
        );
      }

      const updated = await this.client.user.update({
        where: { id: targetUser.id },
        data: {
          githubUsername: profile.login,
          githubId: String(profile.id),
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          githubUsername: true,
          isActive: true,
          tokenVersion: true,
        },
      });

      await this.auditService.recordEvent({
        entityType: "USER",
        entityId: targetUser.id,
        actorType: "USER",
        actorUserId: targetUser.id,
        action: "GITHUB_IDENTITY_LINKED",
        metadata: {
          githubUsername: profile.login,
          githubId: profile.id,
        },
        correlationId: `corr_oauth_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      });

      resolvedUser = {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        githubUsername: updated.githubUsername,
        isActive: updated.isActive,
        tokenVersion: updated.tokenVersion,
      };
    } else {
      // Login Mode
      if (statePayload.userId) {
        throw new DomainValidationError("Invalid OAuth state: userId must not be present for login action");
      }

      if (conflictingUser) {
        // User found by GitHub identity
        if (!conflictingUser.isActive || conflictingUser.suspendedAt !== null) {
          throw new DomainUnauthorizedError(`User account '${conflictingUser.id}' is inactive or suspended`);
        }

        // Update username or githubId if needed
        const updated = await this.client.user.update({
          where: { id: conflictingUser.id },
          data: {
            githubUsername: profile.login,
            githubId: String(profile.id),
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            githubUsername: true,
            isActive: true,
            tokenVersion: true,
          },
        });

        await this.auditService.recordEvent({
          entityType: "USER",
          entityId: conflictingUser.id,
          actorType: "USER",
          actorUserId: conflictingUser.id,
          action: "USER_AUTHENTICATED_VIA_GITHUB_OAUTH",
          metadata: {
            githubUsername: profile.login,
            githubId: profile.id,
          },
          correlationId: `corr_oauth_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        });

        resolvedUser = {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          role: updated.role,
          githubUsername: updated.githubUsername,
          isActive: updated.isActive,
          tokenVersion: updated.tokenVersion,
        };
      } else {
        // Check by verified email address
        const userByEmail = await this.client.user.findUnique({
          where: { email: verifiedEmail },
          select: {
            id: true,
            email: true,
            githubUsername: true,
            githubId: true,
          },
        });

        // Never automatically merge accounts based only on an email address!
        if (userByEmail) {
          throw new DomainConflictError(
            `An account with email '${verifiedEmail}' already exists. Please log in with your primary credentials and link your GitHub account in settings.`
          );
        }

        // Auto-provision a new user account with default DEVELOPER role
        const newUserId = `usr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const created = await this.client.user.create({
          data: {
            id: newUserId,
            email: verifiedEmail,
            name: profile.name || profile.login,
            role: "DEVELOPER",
            githubUsername: profile.login,
            githubId: String(profile.id),
            isActive: true,
            tokenVersion: 1,
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            githubUsername: true,
            isActive: true,
            tokenVersion: true,
          },
        });

        await this.auditService.recordEvent({
          entityType: "USER",
          entityId: created.id,
          actorType: "USER",
          actorUserId: created.id,
          action: "USER_CREATED_VIA_GITHUB_OAUTH",
          metadata: {
            githubUsername: profile.login,
            githubId: profile.id,
          },
          correlationId: `corr_oauth_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        });

        resolvedUser = {
          id: created.id,
          email: created.email,
          name: created.name,
          role: created.role,
          githubUsername: created.githubUsername,
          isActive: created.isActive,
          tokenVersion: created.tokenVersion,
        };
      }
    }

    // 10. Generate VeriRelease session token
    const sessionToken = this.authService.generateToken(resolvedUser.id, {
      tokenVersion: resolvedUser.tokenVersion,
      expiresInSeconds: DEFAULT_TOKEN_TTL_SECONDS,
    });

    const sessionCookieHeader = this.buildCookieHeader(SESSION_COOKIE_NAME, sessionToken, {
      maxAge: DEFAULT_TOKEN_TTL_SECONDS,
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: "Lax",
      path: "/",
    });

    return {
      user: resolvedUser,
      sessionToken,
      returnTo: statePayload.returnTo || "/",
      clearStateCookieHeader,
      sessionCookieHeader,
    };
  }

  /**
   * Unlinks a user's GitHub identity and records an audit log event.
   */
  async unlinkGitHubAccount(userId: string): Promise<void> {
    if (!userId || typeof userId !== "string") {
      throw new DomainValidationError("Valid userId is required to unlink GitHub identity");
    }

    const user = await this.client.user.findUnique({
      where: { id: userId },
      select: { id: true, githubUsername: true, githubId: true },
    });

    if (!user) {
      throw new DomainUnauthorizedError(`User '${userId}' not found`);
    }

    if (!user.githubUsername && !user.githubId) {
      return; // Already unlinked
    }

    const prevUsername = user.githubUsername;
    const prevId = user.githubId;

    await this.client.user.update({
      where: { id: userId },
      data: {
        githubUsername: null,
        githubId: null,
      },
    });

    await this.auditService.recordEvent({
      entityType: "USER",
      entityId: userId,
      actorType: "USER",
      actorUserId: userId,
      action: "GITHUB_IDENTITY_UNLINKED",
      metadata: {
        previousGithubUsername: prevUsername,
        previousGithubId: prevId,
      },
      correlationId: `corr_oauth_unlink_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });
  }

  /**
   * Deletes expired OAuth transactions from the server-side store.
   */
  async pruneExpiredTransactions(now: Date = new Date()): Promise<number> {
    return this.transactionStore.pruneExpired(now);
  }
}

export const githubOAuthService = new GitHubOAuthService();
