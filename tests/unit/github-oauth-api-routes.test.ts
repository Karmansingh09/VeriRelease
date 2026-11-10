import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as loginGet } from "../../src/app/api/auth/github/login/route";
import { GET as callbackGet } from "../../src/app/api/auth/github/callback/route";
import { GET as meGet } from "../../src/app/api/auth/me/route";
import { POST as logoutPost } from "../../src/app/api/auth/logout/route";
import { authService, githubOAuthService } from "../../src/modules/auth";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../src/modules/common/errors";

describe("GitHub OAuth API Endpoints Unit Test Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/auth/github/login", () => {
    it("redirects to GitHub authorization endpoint with state cookie attached", async () => {
      const req = new NextRequest("http://localhost:3000/api/auth/github/login?returnTo=/dashboard");

      const res = await loginGet(req);
      expect(res.status).toBe(302);

      const location = res.headers.get("location");
      expect(location).toContain("https://github.com/login/oauth/authorize");
      expect(location).toContain("state=");

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("vr_oauth_state=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
    });

    it("returns JSON with authorizationUrl when format=json is specified", async () => {
      const req = new NextRequest("http://localhost:3000/api/auth/github/login?format=json");

      const res = await loginGet(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.authorizationUrl).toContain("https://github.com/login/oauth/authorize");

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("vr_oauth_state=");
    });

    it("returns 401 Unauthorized when unauthenticated request attempts action=link", async () => {
      // Mock unauthenticated
      vi.spyOn(authService, "authenticateRequest").mockRejectedValue(
        new DomainUnauthorizedError("No session")
      );

      const req = new NextRequest("http://localhost:3000/api/auth/github/login?action=link");

      const res = await loginGet(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
      expect(json.message).toContain("Must be authenticated");
    });

    it("allows authenticated user to initiate account linking", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_alice",
        email: "alice@test.com",
        name: "Alice",
        role: "DEVELOPER",
        githubUsername: null,
        isActive: true,
        tokenVersion: 1,
      });

      const req = new NextRequest("http://localhost:3000/api/auth/github/login?action=link&format=json");

      const res = await loginGet(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.authorizationUrl).toContain("https://github.com/login/oauth/authorize");
    });
  });

  describe("GET /api/auth/github/callback", () => {
    it("successfully completes OAuth flow and delivers session cookie", async () => {
      vi.spyOn(githubOAuthService, "handleCallback").mockResolvedValue({
        user: {
          id: "usr_alice",
          email: "alice@test.com",
          name: "Alice",
          role: "DEVELOPER",
          githubUsername: "alice_gh",
          isActive: true,
          tokenVersion: 1,
        },
        sessionToken: "vr_auth.test_payload.test_sig",
        returnTo: "/dashboard",
        clearStateCookieHeader: "vr_oauth_state=; Max-Age=0; Path=/",
        sessionCookieHeader: "vr_session=vr_auth.test_payload.test_sig; HttpOnly; Path=/",
      });

      const req = new NextRequest(
        "http://localhost:3000/api/auth/github/callback?code=gh_code_123&state=vr_state.test"
      );

      const res = await callbackGet(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");

      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.includes("vr_session="))).toBe(true);
      expect(cookies.some((c) => c.includes("vr_oauth_state="))).toBe(true);
    });

    it("returns JSON with user profile when format=json requested", async () => {
      vi.spyOn(githubOAuthService, "handleCallback").mockResolvedValue({
        user: {
          id: "usr_alice",
          email: "alice@test.com",
          name: "Alice",
          role: "DEVELOPER",
          githubUsername: "alice_gh",
          isActive: true,
          tokenVersion: 1,
        },
        sessionToken: "vr_auth.test_payload.test_sig",
        returnTo: "/dashboard",
        clearStateCookieHeader: "vr_oauth_state=; Max-Age=0; Path=/",
        sessionCookieHeader: "vr_session=vr_auth.test_payload.test_sig; HttpOnly; Path=/",
      });

      const req = new NextRequest(
        "http://localhost:3000/api/auth/github/callback?code=gh_code_123&state=vr_state.test&format=json"
      );

      const res = await callbackGet(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.user.id).toBe("usr_alice");
      expect(json.user.githubUsername).toBe("alice_gh");
      // Session token is NOT in JSON body!
      expect(json.sessionToken).toBeUndefined();
    });

    it("returns 409 Conflict when GitHub identity is already claimed by another user", async () => {
      vi.spyOn(githubOAuthService, "handleCallback").mockRejectedValue(
        new DomainConflictError("GitHub account 'alice_gh' is already linked to another VeriRelease user")
      );

      const req = new NextRequest(
        "http://localhost:3000/api/auth/github/callback?code=code&state=state"
      );

      const res = await callbackGet(req);
      expect(res.status).toBe(409);

      const json = await res.json();
      expect(json.error).toBe("Conflict");
      expect(json.message).toContain("already linked");
    });

    it("returns 400 Bad Request when validation fails", async () => {
      vi.spyOn(githubOAuthService, "handleCallback").mockRejectedValue(
        new DomainValidationError("Missing code")
      );

      const req = new NextRequest("http://localhost:3000/api/auth/github/callback");

      const res = await callbackGet(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("Validation Error");
    });

    it("returns 401 Unauthorized when state check or signature fails", async () => {
      vi.spyOn(githubOAuthService, "handleCallback").mockRejectedValue(
        new DomainUnauthorizedError("State signature failed")
      );

      const req = new NextRequest(
        "http://localhost:3000/api/auth/github/callback?code=code&state=bad_state"
      );

      const res = await callbackGet(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("returns 403 Forbidden when email is unverified", async () => {
      vi.spyOn(githubOAuthService, "handleCallback").mockRejectedValue(
        new DomainForbiddenError("Verified email required")
      );

      const req = new NextRequest(
        "http://localhost:3000/api/auth/github/callback?code=code&state=state"
      );

      const res = await callbackGet(req);
      expect(res.status).toBe(403);

      const json = await res.json();
      expect(json.error).toBe("Forbidden");
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns authenticated user details when called with valid session", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_alice",
        email: "alice@test.com",
        name: "Alice",
        role: "DEVELOPER",
        githubUsername: "alice_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const req = new NextRequest("http://localhost:3000/api/auth/me");
      const res = await meGet(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.user.id).toBe("usr_alice");
      expect(json.user.email).toBe("alice@test.com");
      expect(json.user.githubUsername).toBe("alice_gh");
    });

    it("returns 401 Unauthorized when session is missing or invalid", async () => {
      vi.spyOn(authService, "authenticateRequest").mockRejectedValue(
        new DomainUnauthorizedError("Missing or invalid Authorization header or session cookie")
      );

      const req = new NextRequest("http://localhost:3000/api/auth/me");
      const res = await meGet(req);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears the session cookie and returns success when CSRF validation passes", async () => {
      const req = new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
        },
      });
      const res = await logoutPost(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("vr_session=");
      expect(setCookie).toContain("Max-Age=0");
    });

    it("rejects logout with 403 Forbidden when Origin header does not match host on cookie-authenticated request (CSRF protection)", async () => {
      const req = new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://evil-attacker.com",
          cookie: "vr_session=active_session_token",
        },
      });
      const res = await logoutPost(req);
      expect(res.status).toBe(403);

      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(json.message).toContain("CSRF");
    });
  });
});
