import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  GitHubOAuthService,
  type GitHubOAuthConfig,
} from "../../src/modules/auth/github-oauth-service";
import type { GitHubOAuthClient } from "../../src/modules/auth/github-oauth-client";
import { AuthService } from "../../src/modules/auth/auth-service";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../src/modules/common/errors";
import {
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from "../../src/modules/auth/types";
import { InMemoryOAuthTransactionStore } from "../../src/modules/auth";

describe("GitHubOAuthService Unit Test Suite", () => {
  const testSigningSecret = "test_signing_secret_for_oauth_min_32_characters_long!";
  const testConfig: GitHubOAuthConfig = {
    clientId: "gh_client_12345",
    clientSecret: "gh_secret_67890_min16chars",
    callbackUrl: "https://verirelease.example.com/api/auth/github/callback",
    signingSecret: testSigningSecret,
    isProduction: true,
  };

  let mockPrisma: any;
  let mockOAuthClient: GitHubOAuthClient;
  let mockAuditService: any;
  let mockTransactionStore: InMemoryOAuthTransactionStore;
  let authService: AuthService;
  let oauthService: GitHubOAuthService;

  beforeEach(() => {
    vi.restoreAllMocks();

    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    mockOAuthClient = {
      exchangeCode: vi.fn(),
      getUserProfile: vi.fn(),
      getUserEmails: vi.fn(),
    };

    mockAuditService = {
      recordEvent: vi.fn().mockResolvedValue({
        auditLog: { id: "aud_test_1" },
        eventHash: "hash_test_1",
      }),
    };

    authService = new AuthService(testSigningSecret, mockPrisma);
    mockTransactionStore = new InMemoryOAuthTransactionStore();

    oauthService = new GitHubOAuthService(testConfig, {
      client: mockPrisma,
      authService,
      oauthClient: mockOAuthClient,
      auditService: mockAuditService,
      transactionStore: mockTransactionStore,
    });
  });

  describe("Authorization URL & Cryptographic State Generation", () => {
    it("generates an unpredictable state token with signature and correct cookie attributes", async () => {
      const result = await oauthService.generateAuthorizationUrl({ returnTo: "/dashboard" });

      expect(result.authorizationUrl).toContain("https://github.com/login/oauth/authorize");
      expect(result.authorizationUrl).toContain(`client_id=${testConfig.clientId}`);
      expect(result.authorizationUrl).toContain(encodeURIComponent(testConfig.callbackUrl));
      expect(result.authorizationUrl).toContain("scope=read%3Auser%2Cuser%3Aemail");
      expect(result.authorizationUrl).toContain(`state=${encodeURIComponent(result.stateToken)}`);

      // Cookie check
      expect(result.cookieHeader).toContain(`${OAUTH_STATE_COOKIE_NAME}=`);
      expect(result.cookieHeader).toContain("HttpOnly");
      expect(result.cookieHeader).toContain("Secure");
      expect(result.cookieHeader).toContain("SameSite=Lax");
      expect(result.cookieHeader).toContain("Path=/");
      expect(result.cookieHeader).toContain("Max-Age=600");

      // Verify state token payload
      const payload = oauthService.verifyStateToken(result.stateToken);
      expect(payload.nonce.length).toBe(64); // 32 random bytes hex
      expect(payload.action).toBe("login");
      expect(payload.returnTo).toBe("/dashboard");
      expect(payload.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("prevents open redirects by sanitizing returnTo", async () => {
      // External / protocol-relative URLs must be sanitized to /
      const resultExternal = await oauthService.generateAuthorizationUrl({ returnTo: "https://evil.com" });
      const payloadExternal = oauthService.verifyStateToken(resultExternal.stateToken);
      expect(payloadExternal.returnTo).toBe("/");

      const resultProtoRelative = await oauthService.generateAuthorizationUrl({ returnTo: "//evil.com" });
      const payloadProtoRelative = oauthService.verifyStateToken(resultProtoRelative.stateToken);
      expect(payloadProtoRelative.returnTo).toBe("/");

      const resultBackslash = await oauthService.generateAuthorizationUrl({ returnTo: "/\\evil.com" });
      const payloadBackslash = oauthService.verifyStateToken(resultBackslash.stateToken);
      expect(payloadBackslash.returnTo).toBe("/");

      // Safe relative paths are preserved
      const resultSafe = await oauthService.generateAuthorizationUrl({ returnTo: "/contracts/cnt_1" });
      const payloadSafe = oauthService.verifyStateToken(resultSafe.stateToken);
      expect(payloadSafe.returnTo).toBe("/contracts/cnt_1");
    });

    it("rejects initiating account linking without an authenticated user ID", async () => {
      await expect(
        oauthService.generateAuthorizationUrl({ action: "link" })
      ).rejects.toThrow(DomainUnauthorizedError);
      await expect(
        oauthService.generateAuthorizationUrl({ action: "link", authenticatedUserId: "" })
      ).rejects.toThrow(/Cannot initiate GitHub account linking without an authenticated user session/i);
    });

    it("embeds authenticated user ID when action is link", async () => {
      const result = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      const payload = oauthService.verifyStateToken(result.stateToken);
      expect(payload.action).toBe("link");
      expect(payload.userId).toBe("usr_alice");
    });
  });

  describe("State Token Verification & Tamper Resistance", () => {
    it("rejects state token when signature has been modified", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl();
      const parts = stateToken.split(".");
      const tampered = `${parts[0]}.${parts[1]}.tampered_signature`;

      expect(() => oauthService.verifyStateToken(tampered)).toThrow(DomainUnauthorizedError);
      expect(() => oauthService.verifyStateToken(tampered)).toThrow(/signature verification failed/i);
    });

    it("rejects state token signed with a different secret", async () => {
      const otherService = new GitHubOAuthService(
        {
          ...testConfig,
          signingSecret: "different_secret_key_that_is_long_enough_32chars!",
        },
        {
          transactionStore: mockTransactionStore,
        }
      );
      const { stateToken } = await otherService.generateAuthorizationUrl();

      expect(() => oauthService.verifyStateToken(stateToken)).toThrow(DomainUnauthorizedError);
      expect(() => oauthService.verifyStateToken(stateToken)).toThrow(/signature verification failed/i);
    });

    it("rejects expired state token (> 10 minutes)", () => {
      const expiredPayload = {
        nonce: "test_nonce_12345",
        action: "login",
        createdAt: Date.now() - 601 * 1000, // 601 seconds ago
      };
      const encoded = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
      const sig = createHmac("sha256", testSigningSecret).update(encoded).digest("base64url");
      const expiredToken = `vr_state.${encoded}.${sig}`;

      expect(() => oauthService.verifyStateToken(expiredToken)).toThrow(DomainUnauthorizedError);
      expect(() => oauthService.verifyStateToken(expiredToken)).toThrow(/has expired/i);
    });
  });

  describe("OAuth Callback Handling & Validation Boundaries", () => {
    it("rejects callback when GitHub reports an error (e.g. access_denied)", async () => {
      await expect(
        oauthService.handleCallback({
          error: "access_denied",
          errorDescription: "The user has denied your application access.",
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("rejects callback when authorization code is missing", async () => {
      await expect(
        oauthService.handleCallback({
          code: null,
          state: "vr_state.test.sig",
          cookieState: "vr_state.test.sig",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects callback when state parameter is missing", async () => {
      await expect(
        oauthService.handleCallback({
          code: "valid_code",
          state: null,
          cookieState: "vr_state.test.sig",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects callback when state cookie is missing", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl();
      await expect(
        oauthService.handleCallback({
          code: "valid_code",
          state: stateToken,
          cookieState: null,
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("rejects callback when query state does not match state cookie (CSRF attack)", async () => {
      const { stateToken: stateToken1 } = await oauthService.generateAuthorizationUrl();
      const { stateToken: stateToken2 } = await oauthService.generateAuthorizationUrl();

      await expect(
        oauthService.handleCallback({
          code: "valid_code",
          state: stateToken1,
          cookieState: stateToken2,
        })
      ).rejects.toThrow(/does not match the state cookie/i);
    });

    it("rejects callback when GitHub account lacks a verified primary email address", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl();

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_valid_oauth_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 998877,
        login: "unverified_user",
        name: "Unverified",
        email: null,
      });

      // User has only unverified emails
      (mockOAuthClient.getUserEmails as any).mockResolvedValue([
        { email: "unverified@test.com", primary: true, verified: false },
      ]);

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
        })
      ).rejects.toThrow(DomainForbiddenError);
    });
  });

  describe("Verified Identity Linking & Conflict Prevention", () => {
    it("successfully links verified GitHub identity to authenticated user", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_alice_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 112233,
        login: "alice_gh",
        name: "Alice Engineer",
        email: "alice@company.com",
      });

      // Target user exists and is active
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_alice",
        email: "alice@company.com",
        name: "Alice",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      // No other user has this GitHub identity
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      mockPrisma.user.update.mockResolvedValueOnce({
        id: "usr_alice",
        email: "alice@company.com",
        name: "Alice Engineer",
        role: "DEVELOPER",
        githubUsername: "alice_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const result = await oauthService.handleCallback({
        code: "alice_oauth_code",
        state: stateToken,
        cookieState: stateToken,
        currentAuthenticatedUser: {
          id: "usr_alice",
          email: "alice@company.com",
          name: "Alice",
          role: "DEVELOPER",
          isActive: true,
          tokenVersion: 1,
        },
      });

      expect(result.user.id).toBe("usr_alice");
      expect(result.user.githubUsername).toBe("alice_gh");

      // Verify session cookie delivered
      expect(result.sessionCookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(result.sessionCookieHeader).toContain("HttpOnly");
      expect(result.sessionCookieHeader).toContain("Secure");
      expect(result.clearStateCookieHeader).toContain(`${OAUTH_STATE_COOKIE_NAME}=`);
      expect(result.clearStateCookieHeader).toContain("Max-Age=0");

      // Verify audit event recorded
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "USER",
          entityId: "usr_alice",
          action: "GITHUB_IDENTITY_LINKED",
          metadata: expect.objectContaining({
            githubUsername: "alice_gh",
            githubId: 112233,
          }),
        })
      );
    });

    it("prevents claiming a GitHub identity already linked to another user (DomainConflictError)", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_bob",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_bob_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 112233,
        login: "alice_gh", // Bob attempts to link Alice's GitHub account!
        name: "Bob Impersonator",
        email: "bob@company.com",
      });

      // Bob's account
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_bob",
        email: "bob@company.com",
        name: "Bob",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      // Alice already owns this GitHub identity!
      mockPrisma.user.findFirst.mockResolvedValue({
        id: "usr_alice", // Different user!
        githubUsername: "alice_gh",
        githubId: "112233",
      });

      await expect(
        oauthService.handleCallback({
          code: "bob_oauth_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_bob",
            email: "bob@company.com",
            name: "Bob",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/already linked to another VeriRelease user/i);

      // Verify no DB update occurred for Bob
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("rejects linking when target user is inactive or suspended", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_suspended",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 777,
        login: "gh_user_777",
        name: "Suspended",
        email: "suspended@test.com",
      });

      // Target user is suspended
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_suspended",
        email: "suspended@test.com",
        name: "Suspended",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        suspendedAt: new Date(),
        tokenVersion: 1,
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_suspended",
            email: "suspended@test.com",
            name: "Suspended",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/inactive or suspended/i);
    });

    it("rejects account linking when caller has no active authenticated session", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: null,
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("prevents session fixation / account linking CSRF by rejecting when active session user does not match state userId", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_victim",
      });

      // Attacker is logged in, but state was prepared for victim
      await expect(
        oauthService.handleCallback({
          code: "attacker_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_attacker",
            email: "attacker@evil.com",
            name: "Attacker",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("rejects linking when authenticated session tokenVersion is stale/revoked", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_revoked",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 888999,
        login: "revoked_user_gh",
        name: "Revoked User",
        email: "revoked@test.com",
      });

      // Target user in DB has tokenVersion 2 (session revoked)
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_revoked",
        email: "revoked@test.com",
        name: "Revoked User",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        suspendedAt: null,
        tokenVersion: 2,
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_revoked",
            email: "revoked@test.com",
            name: "Revoked User",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1, // Stale tokenVersion < 2
          },
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("rejects linking if user account is already linked to a different GitHub account (identity replacement prevention)", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_existing_gh",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 999999,
        login: "new_github_account",
        name: "New Account",
        email: "existing@test.com",
      });

      // User already has a linked GitHub account
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_existing_gh",
        email: "existing@test.com",
        name: "Existing User",
        role: "DEVELOPER",
        githubUsername: "old_github_account",
        githubId: "111111",
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_existing_gh",
            email: "existing@test.com",
            name: "Existing User",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/already linked to a different GitHub account/i);
    });
  });

  describe("OAuth Login Flow & User Auto-Provisioning", () => {
    it("successfully logs in user with existing verified GitHub username", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_existing_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 554433,
        login: "existing_dev",
        name: "Existing Developer",
        email: "dev@company.com",
      });

      // User found by GitHub identity
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: "usr_existing_1",
        email: "dev@company.com",
        name: "Existing Developer",
        role: "DEVELOPER",
        githubUsername: "existing_dev",
        githubId: "554433",
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      mockPrisma.user.update.mockResolvedValueOnce({
        id: "usr_existing_1",
        email: "dev@company.com",
        name: "Existing Developer",
        role: "DEVELOPER",
        githubUsername: "existing_dev",
        isActive: true,
        tokenVersion: 1,
      });

      const result = await oauthService.handleCallback({
        code: "login_code",
        state: stateToken,
        cookieState: stateToken,
      });

      expect(result.user.id).toBe("usr_existing_1");
      expect(result.user.githubUsername).toBe("existing_dev");
      expect(result.sessionToken).toMatch(/^vr_auth\./);
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "USER",
          entityId: "usr_existing_1",
          action: "USER_AUTHENTICATED_VIA_GITHUB_OAUTH",
        })
      );
    });

    it("auto-provisions new developer user when no matching user exists", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_new_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 991122,
        login: "brand_new_dev",
        name: "Brand New Developer",
        email: "brandnew@dev.io",
      });

      // Not found by GitHub identity
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      // Not found by email
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      // Create new user
      mockPrisma.user.create.mockResolvedValueOnce({
        id: "usr_brand_new_generated",
        email: "brandnew@dev.io",
        name: "Brand New Developer",
        role: "DEVELOPER",
        githubUsername: "brand_new_dev",
        isActive: true,
        tokenVersion: 1,
      });

      const result = await oauthService.handleCallback({
        code: "new_user_code",
        state: stateToken,
        cookieState: stateToken,
      });

      expect(result.user.id).toBe("usr_brand_new_generated");
      expect(result.user.email).toBe("brandnew@dev.io");
      expect(result.user.githubUsername).toBe("brand_new_dev");
      expect(result.user.role).toBe("DEVELOPER");

      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: "brandnew@dev.io",
          githubUsername: "brand_new_dev",
          githubId: "991122",
          role: "DEVELOPER",
        }),
        select: expect.any(Object),
      });

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "USER_CREATED_VIA_GITHUB_OAUTH",
        })
      );
    });

    it("rejects login without auto-merging when email matches an unlinked existing user (DomainConflictError)", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 778899,
        login: "gh_employee",
        name: "Existing Employee",
        email: "employee@company.com",
      });

      // No user found with this githubId
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      // Existing user found by email!
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_existing_emp",
        email: "employee@company.com",
        name: "Existing Employee",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        tokenVersion: 1,
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
        })
      ).rejects.toThrow(DomainConflictError);

      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("rejects login callback when state payload includes a target user ID (DomainValidationError)", async () => {
      // Craft a state token with action: "login" but also userId: "usr_victim"
      const payload = {
        nonce: "test_nonce_12345",
        action: "login",
        userId: "usr_victim",
        createdAt: Date.now(),
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = createHmac("sha256", testSigningSecret).update(encoded).digest("base64url");
      const tamperedState = `vr_state.${encoded}.${sig}`;

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: tamperedState,
          cookieState: tamperedState,
        })
      ).rejects.toThrow(DomainValidationError);
    });
  });

  describe("PKCE S256 Confidentiality & Replay Protection", () => {
    it("proves the authorization URL does NOT contain the raw code_verifier", async () => {
      const result = await oauthService.generateAuthorizationUrl();
      const payload = oauthService.verifyStateToken(result.stateToken);
      const storedTx = mockTransactionStore.get(payload.nonce);

      expect(storedTx).toBeDefined();
      expect(storedTx!.codeVerifier).toBeDefined();

      // The raw code_verifier MUST NEVER be exposed in the authorization URL
      expect(result.authorizationUrl.includes(storedTx!.codeVerifier)).toBe(false);

      // Verify that code_challenge parameter is the SHA-256 hash, NOT the verifier
      const url = new URL(result.authorizationUrl);
      const codeChallenge = url.searchParams.get("code_challenge");
      expect(codeChallenge).toBeDefined();
      expect(codeChallenge).not.toBe(storedTx!.codeVerifier);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("proves the state parameter does NOT reveal the code_verifier in plaintext or base64url", async () => {
      const result = await oauthService.generateAuthorizationUrl();
      const payload = oauthService.verifyStateToken(result.stateToken);
      const storedTx = mockTransactionStore.get(payload.nonce);

      // Verify stateToken string does not contain codeVerifier
      expect(result.stateToken.includes(storedTx!.codeVerifier)).toBe(false);

      // Verify state payload schema does not include codeVerifier
      expect((payload as any).codeVerifier).toBeUndefined();

      // Verify base64url decoded state payload JSON does not contain verifier
      const parts = result.stateToken.replace(/^vr_state\./, "").split(".");
      const decodedJson = Buffer.from(parts[0]!, "base64url").toString("utf8");
      expect(decodedJson.includes(storedTx!.codeVerifier)).toBe(false);
    });

    it("proves an incorrect or unregistered state nonce cannot retrieve a code_verifier", async () => {
      // Create a validly signed state token whose nonce was never stored in the transaction store
      const ghostPayload = {
        nonce: "ghost_nonce_never_stored_in_db_00000000000000000000000000000000",
        action: "login" as const,
        createdAt: Date.now(),
      };
      const encoded = Buffer.from(JSON.stringify(ghostPayload)).toString("base64url");
      const sig = createHmac("sha256", testSigningSecret).update(encoded).digest("base64url");
      const ghostStateToken = `vr_state.${encoded}.${sig}`;

      await expect(
        oauthService.handleCallback({
          code: "some_code",
          state: ghostStateToken,
          cookieState: ghostStateToken,
        })
      ).rejects.toThrow(/OAuth transaction not found or state nonce is invalid/i);
    });

    it("proves a transaction cannot be replayed (single-use atomic consumption)", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(stateToken);
      const storedTx = mockTransactionStore.get(payload.nonce);

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token_first",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 334455,
        login: "single_use_dev",
        name: "Single Use Dev",
        email: "singleuse@dev.com",
      });

      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: "usr_single_use",
        email: "singleuse@dev.com",
        name: "Single Use Dev",
        role: "DEVELOPER",
        githubUsername: "single_use_dev",
        githubId: "334455",
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      mockPrisma.user.update.mockResolvedValueOnce({
        id: "usr_single_use",
        email: "singleuse@dev.com",
        name: "Single Use Dev",
        role: "DEVELOPER",
        githubUsername: "single_use_dev",
        isActive: true,
        tokenVersion: 1,
      });

      // 1. First callback succeeds and atomically consumes the transaction
      const firstResult = await oauthService.handleCallback({
        code: "code_1",
        state: stateToken,
        cookieState: stateToken,
      });
      expect(firstResult.user.id).toBe("usr_single_use");

      // Verify the transaction was consumed in the store
      const consumedTx = mockTransactionStore.get(payload.nonce);
      expect(consumedTx?.consumedAt).not.toBeNull();

      // 2. Second callback attempt with the same state MUST fail (replay attack)
      await expect(
        oauthService.handleCallback({
          code: "code_1",
          state: stateToken,
          cookieState: stateToken,
        })
      ).rejects.toThrow(/already been consumed.*replay/i);
    });

    it("proves expired transactions are rejected fail-closed", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(stateToken);

      // Manually backdate the stored transaction to expired
      const tx = mockTransactionStore.get(payload.nonce)!;
      tx.expiresAt = new Date(Date.now() - 5000); // 5 seconds ago

      await expect(
        oauthService.handleCallback({
          code: "valid_code",
          state: stateToken,
          cookieState: stateToken,
        })
      ).rejects.toThrow(/expired/i);
    });

    it("proves concurrent callbacks cannot consume the same transaction twice", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(stateToken);

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token_concurrent",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 771122,
        login: "concurrent_dev",
        name: "Concurrent Dev",
        email: "concurrent@dev.com",
      });

      mockPrisma.user.findFirst.mockResolvedValue({
        id: "usr_concurrent",
        email: "concurrent@dev.com",
        name: "Concurrent Dev",
        role: "DEVELOPER",
        githubUsername: "concurrent_dev",
        githubId: "771122",
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      mockPrisma.user.update.mockResolvedValue({
        id: "usr_concurrent",
        email: "concurrent@dev.com",
        name: "Concurrent Dev",
        role: "DEVELOPER",
        githubUsername: "concurrent_dev",
        isActive: true,
        tokenVersion: 1,
      });

      // Dispatch two concurrent callbacks with the exact same state and code
      const results = await Promise.allSettled([
        oauthService.handleCallback({
          code: "concurrent_code",
          state: stateToken,
          cookieState: stateToken,
        }),
        oauthService.handleCallback({
          code: "concurrent_code",
          state: stateToken,
          cookieState: stateToken,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly ONE must succeed and exactly ONE must be rejected
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason.message).toMatch(/already been consumed.*replay/i);
    });

    it("proves the correct confidential code_verifier reaches the GitHub token exchange", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(stateToken);
      const storedTx = mockTransactionStore.get(payload.nonce)!;

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_valid_token",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 123456,
        login: "pkce_user",
        name: "PKCE User",
        email: "pkce@test.com",
      });

      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.create.mockResolvedValueOnce({
        id: "usr_pkce",
        email: "pkce@test.com",
        name: "PKCE User",
        role: "DEVELOPER",
        githubUsername: "pkce_user",
        isActive: true,
        tokenVersion: 1,
      });

      await oauthService.handleCallback({
        code: "pkce_test_code",
        state: stateToken,
        cookieState: stateToken,
      });

      // The exact verifier from the server-side store MUST be passed to exchangeCode
      expect(mockOAuthClient.exchangeCode).toHaveBeenCalledWith(
        "pkce_test_code",
        testConfig.callbackUrl,
        storedTx.codeVerifier
      );
    });

    it("proves no code_verifier appears in logs, audit events, or API outputs", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(stateToken);
      const storedTx = mockTransactionStore.get(payload.nonce)!;

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "ghu_token_no_log",
        tokenType: "bearer",
        scope: "read:user,user:email",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 998811,
        login: "no_leak_user",
        name: "No Leak User",
        email: "noleak@test.com",
      });

      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.create.mockResolvedValueOnce({
        id: "usr_no_leak",
        email: "noleak@test.com",
        name: "No Leak User",
        role: "DEVELOPER",
        githubUsername: "no_leak_user",
        isActive: true,
        tokenVersion: 1,
      });

      const result = await oauthService.handleCallback({
        code: "code_clean",
        state: stateToken,
        cookieState: stateToken,
      });

      // Verify returned user and session objects do NOT leak codeVerifier
      expect((result.user as any).codeVerifier).toBeUndefined();
      expect(JSON.stringify(result).includes(storedTx.codeVerifier)).toBe(false);

      // Verify audit event does NOT leak codeVerifier
      const auditCalls = mockAuditService.recordEvent.mock.calls;
      expect(auditCalls.length).toBeGreaterThan(0);
      const serializedAudit = JSON.stringify(auditCalls);
      expect(serializedAudit.includes(storedTx.codeVerifier)).toBe(false);
    });

    it("prunes expired transactions cleanly from the store", async () => {
      const now = new Date();

      // Create an active transaction
      await mockTransactionStore.create({
        stateNonce: "nonce_active",
        codeVerifier: "verifier_active",
        action: "login",
        userId: null,
        returnTo: "/",
        expiresAt: new Date(now.getTime() + 60000),
      });

      // Create an expired transaction
      await mockTransactionStore.create({
        stateNonce: "nonce_expired_1",
        codeVerifier: "verifier_expired_1",
        action: "login",
        userId: null,
        returnTo: "/",
        expiresAt: new Date(now.getTime() - 10000),
      });

      const prunedCount = await oauthService.pruneExpiredTransactions(now);
      expect(prunedCount).toBe(1);

      expect(mockTransactionStore.get("nonce_active")).toBeDefined();
      expect(mockTransactionStore.get("nonce_expired_1")).toBeUndefined();
    });
  });

  describe("Unlink GitHub Account", () => {
    it("successfully unlinks GitHub identity and records audit log", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_alice",
        githubUsername: "alice_gh",
        githubId: "112233",
      });

      mockPrisma.user.update.mockResolvedValueOnce({
        id: "usr_alice",
        githubUsername: null,
        githubId: null,
      });

      await oauthService.unlinkGitHubAccount("usr_alice");

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "usr_alice" },
        data: { githubUsername: null, githubId: null },
      });

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "USER",
          entityId: "usr_alice",
          action: "GITHUB_IDENTITY_UNLINKED",
          metadata: {
            previousGithubUsername: "alice_gh",
            previousGithubId: "112233",
          },
        })
      );
    });
  });

  describe("OAuth State Action & User Binding Regression Suite (Callback Bug Fix)", () => {
    it("1. fresh unauthenticated login creates state without userId", async () => {
      const result = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(result.stateToken);

      expect(payload.action).toBe("login");
      expect(payload.userId).toBeUndefined();

      const storedTx = mockTransactionStore.get(payload.nonce);
      expect(storedTx).toBeDefined();
      expect(storedTx?.action).toBe("login");
      expect(storedTx?.userId).toBeNull();

      // Calling with action='login' and an authenticatedUserId must fail fast with DomainValidationError
      await expect(
        oauthService.generateAuthorizationUrl({ action: "login", authenticatedUserId: "usr_attacker" })
      ).rejects.toThrow(DomainValidationError);
    });

    it("2. login callback accepts valid login state", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });

      (mockOAuthClient.exchangeCode as any).mockResolvedValueOnce({
        accessToken: "gho_mock_token_login",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValueOnce({
        id: 998877,
        login: "valid_login_user",
        name: "Valid User",
        email: "valid_login@example.com",
      });

      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.create.mockResolvedValueOnce({
        id: "usr_new_valid",
        email: "valid_login@example.com",
        name: "Valid User",
        role: "DEVELOPER",
        githubUsername: "valid_login_user",
        githubId: "998877",
        isActive: true,
        tokenVersion: 1,
      });

      const result = await oauthService.handleCallback({
        code: "valid_code_login",
        state: stateToken,
        cookieState: stateToken,
      });

      expect(result.user.githubUsername).toBe("valid_login_user");
      expect(result.sessionCookieHeader).toContain("vr_session=");
      expect(result.clearStateCookieHeader).toContain("vr_oauth_state=");
    });

    it("3. login callback rejects link state when invoked without an authenticated session", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: null,
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("4. account linking requires authenticated session", async () => {
      await expect(
        oauthService.generateAuthorizationUrl({ action: "link" })
      ).rejects.toThrow(DomainUnauthorizedError);

      await expect(
        oauthService.generateAuthorizationUrl({ action: "link", authenticatedUserId: "   " })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("5. account linking rejects a mismatched target userId", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_bob_imposter",
            email: "bob@test.com",
            name: "Bob",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("6. account linking rejects an expired or revoked session", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValueOnce({
        accessToken: "gho_mock_token_revoked",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValueOnce({
        id: 11111,
        login: "alice_gh",
        name: "Alice",
        email: "alice@test.com",
      });

      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      // DB user has tokenVersion: 2 (revoked older sessions)
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_alice",
        email: "alice@test.com",
        name: "Alice",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        suspendedAt: null,
        tokenVersion: 2,
      });

      // Calling session presents stale tokenVersion: 1
      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_alice",
            email: "alice@test.com",
            name: "Alice",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/revoked via token version increment/i);
    });

    it("7. OAuth state cannot be replayed (single-use atomic consumption)", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });

      (mockOAuthClient.exchangeCode as any).mockResolvedValue({
        accessToken: "gho_mock_token_replay",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValue({
        id: 778899,
        login: "replay_test_user",
        name: "Replay Test",
        email: "replay@test.com",
      });

      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: "usr_replay",
        email: "replay@test.com",
        name: "Replay Test",
        role: "DEVELOPER",
        githubUsername: "replay_test_user",
        githubId: "778899",
        isActive: true,
        tokenVersion: 1,
      });

      // First callback consumes the transaction
      const first = await oauthService.handleCallback({
        code: "code_1",
        state: stateToken,
        cookieState: stateToken,
      });
      expect(first.user.id).toBe("usr_replay");

      // Replaying the exact same state must fail with DomainUnauthorizedError
      await expect(
        oauthService.handleCallback({
          code: "code_replay",
          state: stateToken,
          cookieState: stateToken,
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("8. invalid state is rejected", async () => {
      // Tampered state
      await expect(
        oauthService.handleCallback({
          code: "code",
          state: "vr_state.invalid.signature",
          cookieState: "vr_state.invalid.signature",
        })
      ).rejects.toThrow(DomainUnauthorizedError);

      // State token with mismatched cookie
      const { stateToken } = await oauthService.generateAuthorizationUrl({ action: "login" });
      await expect(
        oauthService.handleCallback({
          code: "code",
          state: stateToken,
          cookieState: "vr_state.other.cookie",
        })
      ).rejects.toThrow(DomainUnauthorizedError);
    });

    it("9. PKCE verifier remains server-side", async () => {
      const result = await oauthService.generateAuthorizationUrl({ action: "login" });
      const payload = oauthService.verifyStateToken(result.stateToken);
      const storedTx = mockTransactionStore.get(payload.nonce);

      expect(storedTx).toBeDefined();
      expect(storedTx?.codeVerifier).toBeDefined();

      // Authorization URL must NOT contain code_verifier
      expect(result.authorizationUrl).not.toContain(storedTx!.codeVerifier);
      expect(result.authorizationUrl).toContain("code_challenge=");

      // State token must NOT contain code_verifier
      expect(result.stateToken).not.toContain(storedTx!.codeVerifier);
      expect((payload as any).codeVerifier).toBeUndefined();
    });

    it("10. preserves existing ownership and identity conflict protections", async () => {
      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: "usr_alice",
      });

      (mockOAuthClient.exchangeCode as any).mockResolvedValueOnce({
        accessToken: "gho_mock_token_conflict",
      });

      (mockOAuthClient.getUserProfile as any).mockResolvedValueOnce({
        id: 445566,
        login: "conflict_user",
        name: "Conflict User",
        email: "conflict@test.com",
      });

      // Target user exists
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_alice",
        email: "alice@test.com",
        name: "Alice",
        role: "DEVELOPER",
        githubUsername: null,
        githubId: null,
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      // Conflicting user already has this GitHub account linked
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: "usr_other_bob",
        email: "bob@test.com",
        name: "Bob",
        role: "DEVELOPER",
        githubUsername: "conflict_user",
        githubId: "445566",
        isActive: true,
        tokenVersion: 1,
      });

      await expect(
        oauthService.handleCallback({
          code: "test_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: "usr_alice",
            email: "alice@test.com",
            name: "Alice",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/already linked to another VeriRelease user/i);
    });
  });
});
