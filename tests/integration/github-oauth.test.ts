import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/lib/prisma";
import {
  GitHubOAuthService,
  type GitHubOAuthClient,
  type GitHubOAuthUserProfile,
  type GitHubOAuthUserEmail,
} from "../../src/modules/auth";
import { DomainConflictError } from "../../src/modules/common/errors";

describe("GitHub OAuth & Identity Linking Integration Tests (PostgreSQL)", () => {
  const testSigningSecret = "test_signing_secret_for_integration_tests_32chars!";
  let mockOAuthClient: GitHubOAuthClient;
  let oauthService: GitHubOAuthService;

  const createdUserIds: string[] = [];

  beforeEach(async () => {
    mockOAuthClient = {
      exchangeCode: async (code: string) => ({
        accessToken: `ghu_mock_token_${code}`,
        tokenType: "bearer",
        scope: "read:user,user:email",
      }),
      getUserProfile: async (_token: string): Promise<GitHubOAuthUserProfile> => ({
        id: Math.floor(Math.random() * 1000000) + 10000,
        login: `default_dev_${randomUUID().slice(0, 8)}`,
        name: "Default Dev",
        email: "default@dev.test",
      }),
      getUserEmails: async (_token: string): Promise<GitHubOAuthUserEmail[]> => [
        { email: "default@dev.test", primary: true, verified: true },
      ],
    };

    oauthService = new GitHubOAuthService(
      {
        clientId: "test_client_id",
        clientSecret: "test_client_secret_min16chars",
        callbackUrl: "https://verirelease.example.com/api/auth/github/callback",
        signingSecret: testSigningSecret,
        isProduction: false,
      },
      {
        client: prisma,
        oauthClient: mockOAuthClient,
      }
    );
  });

  afterAll(async () => {
    // AuditLog has an immutability trigger preventing row deletion.
    // Nullify githubUsername and githubId on test users so subsequent runs never conflict.
    if (createdUserIds.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: createdUserIds } },
        data: { githubUsername: null, githubId: null },
      });
    }
  });

  describe("Database Constraints: Case-Insensitive Partial Unique Index", () => {
    it("enforces uniqueness of githubUsername case-insensitively while allowing multiple null values", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const user1Id = `usr_test_u1_${runSuffix}`;
      const user2Id = `usr_test_u2_${runSuffix}`;
      const userNull1 = `usr_test_null1_${runSuffix}`;
      const userNull2 = `usr_test_null2_${runSuffix}`;
      createdUserIds.push(user1Id, user2Id, userNull1, userNull2);

      // Multiple users with null githubUsername are permitted
      await prisma.user.create({
        data: {
          id: userNull1,
          email: `${userNull1}@test.com`,
          name: "Null User 1",
          role: "DEVELOPER",
          githubUsername: null,
        },
      });

      await prisma.user.create({
        data: {
          id: userNull2,
          email: `${userNull2}@test.com`,
          name: "Null User 2",
          role: "DEVELOPER",
          githubUsername: null,
        },
      });

      const baseUsername = `octocat_${runSuffix}`;

      // User 1 with lowercase githubUsername
      await prisma.user.create({
        data: {
          id: user1Id,
          email: `${user1Id}@test.com`,
          name: "User 1",
          role: "DEVELOPER",
          githubUsername: baseUsername.toLowerCase(),
        },
      });

      // User 2 attempting to claim same username with uppercase letters MUST fail at DB level
      await expect(
        prisma.user.create({
          data: {
            id: user2Id,
            email: `${user2Id}@test.com`,
            name: "User 2",
            role: "DEVELOPER",
            githubUsername: baseUsername.toUpperCase(),
          },
        })
      ).rejects.toThrow();
    });

    it("enforces uniqueness of githubId while allowing multiple null values", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const u1 = `usr_ghid_1_${runSuffix}`;
      const u2 = `usr_ghid_2_${runSuffix}`;
      createdUserIds.push(u1, u2);

      const dynamicGithubId = String(Math.floor(Math.random() * 90000000) + 10000000);

      await prisma.user.create({
        data: {
          id: u1,
          email: `${u1}@test.com`,
          name: "GHID User 1",
          role: "DEVELOPER",
          githubId: dynamicGithubId,
        },
      });

      // Attempting to duplicate githubId must fail
      await expect(
        prisma.user.create({
          data: {
            id: u2,
            email: `${u2}@test.com`,
            name: "GHID User 2",
            role: "DEVELOPER",
            githubId: dynamicGithubId,
          },
        })
      ).rejects.toThrow();
    });
  });

  describe("End-to-End OAuth Account Linking & Concurrency", () => {
    it("cryptographically links verified GitHub account, persists to PostgreSQL, and records audit event", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const aliceId = `usr_pg_alice_${runSuffix}`;
      createdUserIds.push(aliceId);

      await prisma.user.create({
        data: {
          id: aliceId,
          email: `${aliceId}@company.com`,
          name: "Alice Postgres",
          role: "DEVELOPER",
          githubUsername: null,
          githubId: null,
          isActive: true,
          tokenVersion: 1,
        },
      });

      const dynamicGhId = Math.floor(Math.random() * 900000) + 100000;
      const dynamicGhUsername = `alice_dev_${runSuffix}`;

      // Mock GitHub returning verified profile for alice
      mockOAuthClient.getUserProfile = async () => ({
        id: dynamicGhId,
        login: dynamicGhUsername,
        name: "Alice Verified",
        email: `${aliceId}@company.com`,
      });

      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: aliceId,
        returnTo: "/dashboard",
      });

      const result = await oauthService.handleCallback({
        code: "alice_code_xyz",
        state: stateToken,
        cookieState: stateToken,
        currentAuthenticatedUser: {
          id: aliceId,
          email: `${aliceId}@company.com`,
          name: "Alice Postgres",
          role: "DEVELOPER",
          isActive: true,
          tokenVersion: 1,
        },
      });

      expect(result.user.id).toBe(aliceId);
      expect(result.user.githubUsername).toBe(dynamicGhUsername);

      // Verify persistence in PostgreSQL
      const persistedUser = await prisma.user.findUnique({
        where: { id: aliceId },
      });
      expect(persistedUser?.githubUsername).toBe(dynamicGhUsername);
      expect(persistedUser?.githubId).toBe(String(dynamicGhId));

      // Verify AuditLog persistence in PostgreSQL
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          entityType: "USER",
          entityId: aliceId,
          action: "GITHUB_IDENTITY_LINKED",
        },
      });
      expect(auditLogs.length).toBe(1);
      const firstLog = auditLogs[0];
      expect(firstLog).toBeDefined();
      expect((firstLog?.metadata as any).githubUsername).toBe(dynamicGhUsername);
      expect((firstLog?.metadata as any).githubId).toBe(dynamicGhId);
    });

    it("rejects another user from claiming an already-linked GitHub identity", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const dev1Id = `usr_claim_1_${runSuffix}`;
      const dev2Id = `usr_claim_2_${runSuffix}`;
      createdUserIds.push(dev1Id, dev2Id);

      const dynamicGhId = String(Math.floor(Math.random() * 900000) + 100000);
      const dynamicLogin = `contested_${runSuffix}`;

      // Dev 1 has already linked github account
      await prisma.user.create({
        data: {
          id: dev1Id,
          email: `${dev1Id}@test.com`,
          name: "Dev 1",
          role: "DEVELOPER",
          githubUsername: dynamicLogin,
          githubId: dynamicGhId,
        },
      });

      await prisma.user.create({
        data: {
          id: dev2Id,
          email: `${dev2Id}@test.com`,
          name: "Dev 2",
          role: "DEVELOPER",
          githubUsername: null,
          githubId: null,
        },
      });

      // Dev 2 tries to link the same GitHub identity
      mockOAuthClient.getUserProfile = async () => ({
        id: Number(dynamicGhId),
        login: dynamicLogin,
        name: "Dev 2",
        email: `${dev2Id}@test.com`,
      });

      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: dev2Id,
      });

      await expect(
        oauthService.handleCallback({
          code: "claim_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: dev2Id,
            email: `${dev2Id}@test.com`,
            name: "Dev 2",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(DomainConflictError);

      // Verify Dev 2 was not updated
      const dev2 = await prisma.user.findUnique({ where: { id: dev2Id } });
      expect(dev2?.githubUsername).toBeNull();
    });

    it("unlinks GitHub account cleanly and writes audit record", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const userId = `usr_unlink_${runSuffix}`;
      createdUserIds.push(userId);

      const dynamicGhId = String(Math.floor(Math.random() * 900000) + 100000);
      const dynamicLogin = `unlink_${runSuffix}`;

      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@test.com`,
          name: "Unlink User",
          role: "DEVELOPER",
          githubUsername: dynamicLogin,
          githubId: dynamicGhId,
        },
      });

      await oauthService.unlinkGitHubAccount(userId);

      const updated = await prisma.user.findUnique({ where: { id: userId } });
      expect(updated?.githubUsername).toBeNull();
      expect(updated?.githubId).toBeNull();

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          entityType: "USER",
          entityId: userId,
          action: "GITHUB_IDENTITY_UNLINKED",
        },
      });
      expect(auditLog).not.toBeNull();
      expect((auditLog?.metadata as any).previousGithubUsername).toBe(dynamicLogin);
    });

    it("rejects login without auto-merging when email matches an unlinked existing user (DomainConflictError)", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const existingUserId = `usr_existing_${runSuffix}`;
      const existingEmail = `existing_${runSuffix}@company.com`;
      createdUserIds.push(existingUserId);

      // Create an existing user with email but no GitHub account linked
      await prisma.user.create({
        data: {
          id: existingUserId,
          email: existingEmail,
          name: "Existing Employee",
          role: "DEVELOPER",
          githubUsername: null,
          githubId: null,
          isActive: true,
          tokenVersion: 1,
        },
      });

      const ghId = Math.floor(Math.random() * 900000) + 100000;
      const ghUsername = `unlinked_gh_${runSuffix}`;

      mockOAuthClient.getUserProfile = async () => ({
        id: ghId,
        login: ghUsername,
        name: "Unlinked GH User",
        email: existingEmail,
      });

      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "login",
        returnTo: "/dashboard",
      });

      // Must reject with DomainConflictError instead of silently auto-merging
      await expect(
        oauthService.handleCallback({
          code: "login_code_conflict",
          state: stateToken,
          cookieState: stateToken,
        })
      ).rejects.toThrow(DomainConflictError);

      // Verify the user remains unlinked
      const userAfter = await prisma.user.findUnique({ where: { id: existingUserId } });
      expect(userAfter?.githubUsername).toBeNull();
      expect(userAfter?.githubId).toBeNull();
    });

    it("rejects linking when user already has a linked GitHub account (DomainConflictError)", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const userId = `usr_already_linked_${runSuffix}`;
      const oldGhId = String(Math.floor(Math.random() * 900000) + 100000);
      const oldGhLogin = `old_gh_${runSuffix}`;
      createdUserIds.push(userId);

      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@test.com`,
          name: "Already Linked Dev",
          role: "DEVELOPER",
          githubUsername: oldGhLogin,
          githubId: oldGhId,
          isActive: true,
          tokenVersion: 1,
        },
      });

      const newGhId = Math.floor(Math.random() * 900000) + 100000;
      const newGhLogin = `new_gh_${runSuffix}`;

      mockOAuthClient.getUserProfile = async () => ({
        id: newGhId,
        login: newGhLogin,
        name: "New GH Account",
        email: `${userId}@test.com`,
      });

      const { stateToken } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: userId,
      });

      await expect(
        oauthService.handleCallback({
          code: "replace_attempt_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: userId,
            email: `${userId}@test.com`,
            name: "Already Linked Dev",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/already linked to a different GitHub account/i);

      // Verify existing link is preserved
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.githubUsername).toBe(oldGhLogin);
      expect(userAfter?.githubId).toBe(oldGhId);
    });

    it("persists PKCE verifier to PostgreSQL OAuthTransaction table and prevents replay via atomic consumption", async () => {
      const runSuffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const userId = `usr_pkce_pg_${runSuffix}`;
      createdUserIds.push(userId);

      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@test.com`,
          name: "PKCE PG User",
          role: "DEVELOPER",
          isActive: true,
          tokenVersion: 1,
        },
      });

      const ghId = Math.floor(Math.random() * 900000) + 100000;
      const ghUsername = `pkce_dev_${runSuffix}`;

      mockOAuthClient.getUserProfile = async () => ({
        id: ghId,
        login: ghUsername,
        name: "PKCE PG Dev",
        email: `${userId}@test.com`,
      });

      // 1. Generate authorization URL and record state
      const { stateToken, authorizationUrl } = await oauthService.generateAuthorizationUrl({
        action: "link",
        authenticatedUserId: userId,
        returnTo: "/dashboard",
      });

      const statePayload = oauthService.verifyStateToken(stateToken);

      // Verify that OAuthTransaction was created in PostgreSQL
      const txInDb = await prisma.oAuthTransaction.findUnique({
        where: { stateNonce: statePayload.nonce },
      });
      expect(txInDb).not.toBeNull();
      expect(txInDb?.action).toBe("link");
      expect(txInDb?.consumedAt).toBeNull();
      expect(txInDb?.codeVerifier).toBeDefined();

      // Verify verifier is NOT in the authorizationUrl or stateToken
      expect(authorizationUrl.includes(txInDb!.codeVerifier)).toBe(false);
      expect(stateToken.includes(txInDb!.codeVerifier)).toBe(false);

      // 2. First callback succeeds and atomically consumes the record
      const result = await oauthService.handleCallback({
        code: "pkce_first_code",
        state: stateToken,
        cookieState: stateToken,
        currentAuthenticatedUser: {
          id: userId,
          email: `${userId}@test.com`,
          name: "PKCE PG User",
          role: "DEVELOPER",
          isActive: true,
          tokenVersion: 1,
        },
      });
      expect(result.user.id).toBe(userId);

      // Verify row in PostgreSQL has consumedAt set
      const consumedTx = await prisma.oAuthTransaction.findUnique({
        where: { stateNonce: statePayload.nonce },
      });
      expect(consumedTx?.consumedAt).not.toBeNull();

      // 3. Second callback attempt with the same state MUST fail (replay attack detected)
      await expect(
        oauthService.handleCallback({
          code: "pkce_replay_code",
          state: stateToken,
          cookieState: stateToken,
          currentAuthenticatedUser: {
            id: userId,
            email: `${userId}@test.com`,
            name: "PKCE PG User",
            role: "DEVELOPER",
            isActive: true,
            tokenVersion: 1,
          },
        })
      ).rejects.toThrow(/already been consumed.*replay/i);
    });
  });
});
