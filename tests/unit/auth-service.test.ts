import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthService } from "../../src/modules/auth/auth-service";
import { DomainUnauthorizedError } from "../../src/modules/common/errors";
import { validateEnv } from "../../src/lib/env";

describe("AuthService Unit Test Suite", () => {
  const testSecret = "valid_test_signing_secret_32_characters_long!";
  let mockPrisma: any;
  let authService: AuthService;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: vi.fn(),
      },
    };
    authService = new AuthService(testSecret, mockPrisma);
  });

  describe("Token Generation & Verification", () => {
    it("successfully generates and verifies a valid token", () => {
      const token = authService.generateToken("usr_123", { expiresInSeconds: 3600, tokenVersion: 1 });
      expect(token).toMatch(/^vr_auth\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

      const payload = authService.verifyToken(token);
      expect(payload.userId).toBe("usr_123");
      expect(payload.tokenVersion).toBe(1);
      expect(payload.expiresAt).toBeGreaterThan(payload.issuedAt);
    });

    it("rejects token with invalid signature", () => {
      const token = authService.generateToken("usr_123");
      const parts = token.split(".");
      // Tamper with signature
      const tamperedToken = `${parts[0]}.${parts[1]}.bad_signature`;

      expect(() => authService.verifyToken(tamperedToken)).toThrow(DomainUnauthorizedError);
      expect(() => authService.verifyToken(tamperedToken)).toThrow(/signature verification failed/i);
    });

    it("rejects token signed by a different secret", () => {
      const otherService = new AuthService("another_different_valid_secret_key_12345");
      const token = otherService.generateToken("usr_123");

      expect(() => authService.verifyToken(token)).toThrow(DomainUnauthorizedError);
      expect(() => authService.verifyToken(token)).toThrow(/signature verification failed/i);
    });

    it("rejects expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      // Token expired 10 seconds ago
      const expiredToken = authService.generateToken("usr_123", {
        issuedAt: now - 3600,
        expiresInSeconds: 3590,
      });

      expect(() => authService.verifyToken(expiredToken)).toThrow(DomainUnauthorizedError);
      expect(() => authService.verifyToken(expiredToken)).toThrow(/token has expired/i);
    });

    it("rejects token with future issued-at timestamp", () => {
      const now = Math.floor(Date.now() / 1000);
      // Issued 5 minutes into the future
      const futureToken = authService.generateToken("usr_123", {
        issuedAt: now + 300,
        expiresInSeconds: 3600,
      });

      expect(() => authService.verifyToken(futureToken)).toThrow(DomainUnauthorizedError);
      expect(() => authService.verifyToken(futureToken)).toThrow(/issued in the future/i);
    });

    it("rejects token with excessive lifetime", () => {
      const now = Math.floor(Date.now() / 1000);
      // Attempt to generate token with lifetime > 7 days (604,800s)
      expect(() =>
        authService.generateToken("usr_123", { expiresInSeconds: 800_000 })
      ).toThrow(DomainUnauthorizedError);

      // Verify crafted token with excessive duration is rejected by verifyToken
      const excessivePayload = {
        userId: "usr_123",
        tokenVersion: 1,
        issuedAt: now,
        expiresAt: now + 900_000,
      };
      const crypto = require("node:crypto");
      const encoded = Buffer.from(JSON.stringify(excessivePayload)).toString("base64url");
      const sig = crypto.createHmac("sha256", testSecret).update(encoded).digest("base64url");
      const crafted = `vr_auth.${encoded}.${sig}`;

      expect(() => authService.verifyToken(crafted)).toThrow(DomainUnauthorizedError);
      expect(() => authService.verifyToken(crafted)).toThrow(/exceeds maximum allowed duration/i);
    });

    it("rejects token with invalid payload schema or malformed JSON", () => {
      const crypto = require("node:crypto");
      const badPayloadJson = JSON.stringify({ userId: 12345, issuedAt: "not_a_number" });
      const encoded = Buffer.from(badPayloadJson).toString("base64url");
      const sig = crypto.createHmac("sha256", testSecret).update(encoded).digest("base64url");
      const crafted = `vr_auth.${encoded}.${sig}`;

      expect(() => authService.verifyToken(crafted)).toThrow(DomainUnauthorizedError);
      expect(() => authService.verifyToken(crafted)).toThrow(/invalid schema or types/i);
    });

    it("fails closed when signing secret is missing, empty, or too short", () => {
      expect(() => new AuthService("")).toThrow(DomainUnauthorizedError);
      expect(() => new AuthService("short_secret")).toThrow(DomainUnauthorizedError);
      expect(() => new AuthService("   ")).toThrow(DomainUnauthorizedError);
    });
  });

  describe("Request Authentication & User Status Resolution", () => {
    it("successfully authenticates request for an active, existing user with matching tokenVersion", async () => {
      const token = authService.generateToken("usr_active_1", { tokenVersion: 1 });
      const req = new Request("http://localhost:3000/api/test", {
        headers: { authorization: `Bearer ${token}` },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_active_1",
        email: "active@test.com",
        name: "Active User",
        role: "DEVELOPER",
        githubUsername: "active_dev",
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      const user = await authService.authenticateRequest(req);
      expect(user.id).toBe("usr_active_1");
      expect(user.role).toBe("DEVELOPER");
      expect(user.githubUsername).toBe("active_dev");
      expect(user.isActive).toBe(true);
    });

    it("successfully authenticates request using an HTTP-only vr_session cookie", async () => {
      const token = authService.generateToken("usr_cookie_user", { tokenVersion: 1 });
      const req = new Request("http://localhost:3000/api/test", {
        headers: { cookie: `other_cookie=xyz; vr_session=${token}; another=123` },
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_cookie_user",
        email: "cookie@test.com",
        name: "Cookie User",
        role: "CLIENT",
        githubUsername: "cookie_gh",
        isActive: true,
        suspendedAt: null,
        tokenVersion: 1,
      });

      const user = await authService.authenticateRequest(req);
      expect(user.id).toBe("usr_cookie_user");
      expect(user.email).toBe("cookie@test.com");
      expect(user.role).toBe("CLIENT");
    });

    it("rejects request when neither Authorization header nor session cookie is provided", async () => {
      const req = new Request("http://localhost:3000/api/test");

      await expect(authService.authenticateRequest(req)).rejects.toThrow(DomainUnauthorizedError);
      await expect(authService.authenticateRequest(req)).rejects.toThrow(
        /Missing or invalid Authorization header or session cookie/i
      );
    });

    it("rejects request when user has been deleted from database", async () => {
      const token = authService.generateToken("usr_deleted");
      const req = new Request("http://localhost:3000/api/test", {
        headers: { authorization: `Bearer ${token}` },
      });

      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(authService.authenticateRequest(req)).rejects.toThrow(DomainUnauthorizedError);
      await expect(authService.authenticateRequest(req)).rejects.toThrow(/no longer exists/i);
    });

    it("rejects request when user account is inactive or suspended", async () => {
      const token = authService.generateToken("usr_suspended");
      const req = new Request("http://localhost:3000/api/test", {
        headers: { authorization: `Bearer ${token}` },
      });

      // 1. Inactive account
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_suspended",
        email: "suspended@test.com",
        name: "Suspended User",
        role: "CLIENT",
        githubUsername: null,
        isActive: false,
        suspendedAt: null,
        tokenVersion: 1,
      });

      await expect(authService.authenticateRequest(req)).rejects.toThrow(
        /inactive or suspended/i
      );

      // 2. Suspended with timestamp
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "usr_suspended",
        email: "suspended@test.com",
        name: "Suspended User",
        role: "CLIENT",
        githubUsername: null,
        isActive: true,
        suspendedAt: new Date(),
        tokenVersion: 1,
      });

      await expect(authService.authenticateRequest(req)).rejects.toThrow(
        /inactive or suspended/i
      );
    });

    it("rejects request when token has been revoked via token version increment", async () => {
      // Token was issued at version 1
      const tokenV1 = authService.generateToken("usr_revoked", { tokenVersion: 1 });
      const req = new Request("http://localhost:3000/api/test", {
        headers: { authorization: `Bearer ${tokenV1}` },
      });

      // User's tokenVersion was incremented to 2 (revoking older tokens)
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "usr_revoked",
        email: "revoked@test.com",
        name: "Revoked User",
        role: "CLIENT",
        githubUsername: null,
        isActive: true,
        suspendedAt: null,
        tokenVersion: 2,
      });

      await expect(authService.authenticateRequest(req)).rejects.toThrow(DomainUnauthorizedError);
      await expect(authService.authenticateRequest(req)).rejects.toThrow(/has been revoked/i);
    });
  });

  describe("Environment Configuration & Startup Hardening", () => {
    const baseDevEnv = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test?schema=public",
      GITHUB_WEBHOOK_SECRET: "dev_github_webhook_secret_placeholder",
      AUTH_TOKEN_SIGNING_SECRET: "dev_auth_token_signing_secret_min16chars!",
    };

    it("permits valid configuration in development", () => {
      const config = validateEnv(baseDevEnv);
      expect(config.AUTH_TOKEN_SIGNING_SECRET).toBe("dev_auth_token_signing_secret_min16chars!");
    });

    it("rejects production startup when AUTH_TOKEN_SIGNING_SECRET is too short (<32 chars)", () => {
      const prodEnv = {
        ...baseDevEnv,
        NODE_ENV: "production",
        AUTH_TOKEN_SIGNING_SECRET: "too_short_for_prod",
        GITHUB_WEBHOOK_SECRET: "prod_webhook_secret_32_chars_long_and_valid!",
        OPENAI_API_KEY: "sk-proj-prod-valid-key-12345",
        PAYPAL_CLIENT_ID: "prod_paypal_client_id_12345678",
        PAYPAL_CLIENT_SECRET: "prod_paypal_client_secret_12345678",
        PAYPAL_WEBHOOK_ID: "prod_paypal_webhook_id_12345678",
        GITHUB_APP_ID: "123456",
        GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      };

      expect(() => validateEnv(prodEnv)).toThrow(/at least 32 characters in production/i);
    });

    it("rejects production startup when AUTH_TOKEN_SIGNING_SECRET contains placeholder text", () => {
      const prodEnv = {
        ...baseDevEnv,
        NODE_ENV: "production",
        AUTH_TOKEN_SIGNING_SECRET: "placeholder_auth_secret_longer_than_32_chars_now",
        GITHUB_WEBHOOK_SECRET: "prod_webhook_secret_32_chars_long_and_valid!",
        OPENAI_API_KEY: "sk-proj-prod-valid-key-12345",
        PAYPAL_CLIENT_ID: "prod_paypal_client_id_12345678",
        PAYPAL_CLIENT_SECRET: "prod_paypal_client_secret_12345678",
        PAYPAL_WEBHOOK_ID: "prod_paypal_webhook_id_12345678",
        GITHUB_APP_ID: "123456",
        GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      };

      expect(() => validateEnv(prodEnv)).toThrow(/cannot use placeholder values in production/i);
    });

    it("rejects configuration when AUTH_TOKEN_SIGNING_SECRET reuses GITHUB_WEBHOOK_SECRET", () => {
      const reusedSecret = "exact_same_reused_secret_32_characters_long!";
      const envWithReusedSecret = {
        ...baseDevEnv,
        AUTH_TOKEN_SIGNING_SECRET: reusedSecret,
        GITHUB_WEBHOOK_SECRET: reusedSecret,
      };

      expect(() => validateEnv(envWithReusedSecret)).toThrow(/must not reuse GITHUB_WEBHOOK_SECRET/i);
    });

    it("rejects production startup when GitHub App credentials are missing", () => {
      const prodEnvWithoutApp = {
        ...baseDevEnv,
        NODE_ENV: "production",
        AUTH_TOKEN_SIGNING_SECRET: "prod_auth_secret_32_chars_long_and_independent!",
        GITHUB_WEBHOOK_SECRET: "prod_webhook_secret_32_chars_long_and_valid!",
        OPENAI_API_KEY: "sk-proj-prod-valid-key-12345",
        PAYPAL_CLIENT_ID: "prod_paypal_client_id_12345678",
        PAYPAL_CLIENT_SECRET: "prod_paypal_client_secret_12345678",
        PAYPAL_WEBHOOK_ID: "prod_paypal_webhook_id_12345678",
        GITHUB_OAUTH_CLIENT_ID: "github_oauth_client_id_prod",
        GITHUB_OAUTH_CLIENT_SECRET: "github_oauth_client_secret_prod_min16chars",
        GITHUB_OAUTH_CALLBACK_URL: "https://verirelease.example.com/api/auth/github/callback",
      };

      expect(() => validateEnv(prodEnvWithoutApp)).toThrow(/requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY/i);
    });
  });
});
