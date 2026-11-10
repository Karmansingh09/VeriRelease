import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { POST as webhookPost } from "../../src/app/api/webhooks/github/route";
import {
  POST as repoPost,
  GET as repoGet,
} from "../../src/app/api/contracts/[id]/github-repo/route";
import {
  POST as evidencePost,
  GET as evidenceGet,
} from "../../src/app/api/submissions/[id]/evidence/route";
import { env } from "../../src/lib/env";
import { authService } from "../../src/modules/auth";

describe("GitHub API Endpoints Unit Test Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/webhooks/github", () => {
    function sign(body: string, secret: string = env.GITHUB_WEBHOOK_SECRET): string {
      return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
    }

    it("returns 401 Unauthorized when X-Hub-Signature-256 is invalid", async () => {
      const payload = JSON.stringify({ action: "opened" });
      const req = new NextRequest("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=" + "a".repeat(64),
          "x-github-delivery": "del_api_bad_sig",
          "x-github-event": "pull_request",
          "content-type": "application/json",
        },
        body: payload,
      });

      const res = await webhookPost(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("returns 400 Bad Request when X-GitHub-Delivery header is missing", async () => {
      const payload = JSON.stringify({ action: "opened" });
      const sig = sign(payload);
      const req = new NextRequest("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": sig,
          "x-github-event": "pull_request",
          "content-type": "application/json",
        },
        body: payload,
      });

      const res = await webhookPost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain("X-GitHub-Delivery");
    });

    it("returns 400 Bad Request when payload is malformed non-JSON", async () => {
      const payload = "INVALID_NOT_JSON";
      const sig = sign(payload);
      const req = new NextRequest("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": sig,
          "x-github-delivery": "del_api_bad_json",
          "x-github-event": "pull_request",
          "content-type": "text/plain",
        },
        body: payload,
      });

      const res = await webhookPost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain("Malformed JSON");
    });
  });

  describe("Authentication & Authorization on /api/contracts/[id]/github-repo", () => {
    it("returns 401 Unauthorized when request lacks Authorization header", async () => {
      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_1/github-repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "acme", repo: "project" }),
      });

      const res = await repoPost(req, { params: Promise.resolve({ id: "cnt_1" }) });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("rejects forged userId in request body when Authorization header is missing (returns 401)", async () => {
      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_1/github-repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: "acme",
          repo: "project",
          userId: "usr_client_spoofed",
          userRole: "ADMIN",
        }),
      });

      const res = await repoPost(req, { params: Promise.resolve({ id: "cnt_1" }) });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("returns 401 Unauthorized on GET when request lacks Authorization header", async () => {
      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_1/github-repo");
      const res = await repoGet(req, { params: Promise.resolve({ id: "cnt_1" }) });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("returns 400 Validation Error when authenticated user provides invalid body fields", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_client_1",
        email: "client@test.com",
        name: "Client",
        role: "CLIENT",
        githubUsername: "client_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_1/github-repo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_token",
        },
        body: JSON.stringify({ owner: "" }),
      });

      const res = await repoPost(req, { params: Promise.resolve({ id: "cnt_1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Validation Error");
    });
  });

  describe("Authentication & Authorization on /api/submissions/[id]/evidence", () => {
    it("returns 401 Unauthorized when POST lacks Authorization header", async () => {
      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ milestoneId: "mls_1" }),
      });

      const res = await evidencePost(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("returns 401 Unauthorized when GET lacks Authorization header", async () => {
      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence");
      const res = await evidenceGet(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("returns 400 Validation Error when authenticated user omits milestoneId on POST", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_dev_1",
        email: "dev@test.com",
        name: "Developer",
        role: "DEVELOPER",
        githubUsername: "dev_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_token",
        },
        body: JSON.stringify({}),
      });

      const res = await evidencePost(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Validation Error");
    });

    it("returns 400 Bad Request on GET when version parameter is invalid", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_client_1",
        email: "client@test.com",
        name: "Client",
        role: "CLIENT",
        githubUsername: "client_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence?version=-1", {
        headers: { authorization: "Bearer valid_token" },
      });
      const res = await evidenceGet(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain("Invalid version parameter");
    });
  });
});
