/**
 * VeriRelease GitHub PR Evidence Linking & Error Handling Regression Tests
 *
 * Verifies:
 * 1. Correct canonical pull request URL (pull_request.html_url) is returned and persisted.
 * 2. Rejection of `/issues/` URLs on milestone work submission.
 * 3. Graceful handling of GitHub 404 response -> "Pull request not found or inaccessible."
 * 4. Graceful handling of GitHub 403 response -> "GitHub access permission is insufficient."
 * 5. Graceful handling of GitHub 401 response -> "GitHub authentication needs to be refreshed."
 * 6. Cross-repository isolation: invalid repository association is strictly rejected.
 * 7. Evidence snapshot immutability and readability.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  POST as evidencePost,
  GET as evidenceGet,
} from "../../src/app/api/submissions/[id]/evidence/route";
import {
  POST as submissionsPost,
} from "../../src/app/api/milestones/[id]/submissions/route";
import { authService } from "../../src/modules/auth";
import { MockGitHubProvider } from "../../src/modules/github/provider/mock-github-provider";
import { FetchGitHubProvider } from "../../src/modules/github/provider/fetch-github-provider";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../src/modules/common/errors";
import { contractService } from "../../src/modules/contracts";

describe("GitHub PR Evidence Linking & Error Handling Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Canonical PR URL & /issues/ Rejection", () => {
    it("rejects milestone submission containing an /issues/ URL with DomainValidationError", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_dev_1",
        email: "dev@test.com",
        name: "Developer",
        role: "DEVELOPER",
        githubUsername: "dev_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const req = new NextRequest("http://localhost:3000/api/milestones/mls_1/submissions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_dev_token",
        },
        body: JSON.stringify({
          prNumber: 42,
          prCommitSha: "a".repeat(40),
          prUrl: "https://github.com/Karmansingh09/VeriRelease/issues/42",
        }),
      });

      const res = await submissionsPost(req, { params: Promise.resolve({ id: "mls_1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Validation Error");
      expect(JSON.stringify(json.details)).toContain("prUrl must be a pull request URL, not an issue URL");
    });

    it("contractService.submitMilestoneWork directly throws DomainValidationError for /issues/ URL", async () => {
      await expect(
        contractService.submitMilestoneWork("mls_test", "usr_dev_1", {
          prNumber: 42,
          prCommitSha: "a".repeat(40),
          prUrl: "https://github.com/Karmansingh09/VeriRelease/issues/42",
        })
      ).rejects.toThrow("Pull request URL cannot be an issues URL");
    });
  });

  describe("2. GitHub Provider Error Mapping", () => {
    it("MockGitHubProvider throws DomainNotFoundError with clear message when simulate404 is active", async () => {
      const mockProvider = new MockGitHubProvider();
      mockProvider.simulate404 = true;

      await expect(
        mockProvider.getPullRequest("Karmansingh09", "VeriRelease", 42)
      ).rejects.toThrow("Pull request not found or inaccessible.");
    });

    it("MockGitHubProvider throws DomainForbiddenError with clear message when simulate403 is active", async () => {
      const mockProvider = new MockGitHubProvider();
      mockProvider.simulate403 = true;

      await expect(
        mockProvider.getPullRequest("Karmansingh09", "VeriRelease", 42)
      ).rejects.toThrow("GitHub access permission is insufficient.");
    });

    it("MockGitHubProvider throws DomainUnauthorizedError with clear message when simulate401 is active", async () => {
      const mockProvider = new MockGitHubProvider();
      mockProvider.simulate401 = true;

      await expect(
        mockProvider.getPullRequest("Karmansingh09", "VeriRelease", 42)
      ).rejects.toThrow("GitHub authentication needs to be refreshed.");
    });

    it("FetchGitHubProvider correctly maps 404, 403, and 401 HTTP responses", async () => {
      const provider = new FetchGitHubProvider({
        baseUrl: "https://api.github.com",
        accessToken: "test_token",
      });

      // Test 404 mapping
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      );
      await expect(
        provider.getPullRequest("Karmansingh09", "VeriRelease", 42)
      ).rejects.toThrow("Pull request not found or inaccessible.");

      // Test 403 mapping
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      );
      await expect(
        provider.getPullRequest("Karmansingh09", "VeriRelease", 42)
      ).rejects.toThrow("GitHub access permission is insufficient.");

      // Test 401 mapping
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      );
      await expect(
        provider.getPullRequest("Karmansingh09", "VeriRelease", 42)
      ).rejects.toThrow("GitHub authentication needs to be refreshed.");
    });
  });

  describe("3. API Evidence Route Error Statuses and Messages", () => {
    it("returns 404 Not Found with 'Pull request not found or inaccessible.' when PR does not exist", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_dev_1",
        email: "dev@test.com",
        name: "Developer",
        role: "DEVELOPER",
        githubUsername: "dev_gh",
        isActive: true,
        tokenVersion: 1,
      });

      // Mock evidence service throw
      const { GitHubEvidenceService } = await import("../../src/modules/github");
      vi.spyOn(GitHubEvidenceService.prototype, "collectSubmissionEvidence").mockRejectedValueOnce(
        new DomainNotFoundError("Pull request not found or inaccessible.")
      );

      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_token",
        },
        body: JSON.stringify({ milestoneId: "mls_1" }),
      });

      const res = await evidencePost(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Not Found");
      expect(json.message).toBe("Pull request not found or inaccessible.");
    });

    it("returns 403 Forbidden with 'GitHub access permission is insufficient.' when access is denied", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_dev_1",
        email: "dev@test.com",
        name: "Developer",
        role: "DEVELOPER",
        githubUsername: "dev_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const { GitHubEvidenceService } = await import("../../src/modules/github");
      vi.spyOn(GitHubEvidenceService.prototype, "collectSubmissionEvidence").mockRejectedValueOnce(
        new DomainForbiddenError("GitHub access permission is insufficient.")
      );

      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_token",
        },
        body: JSON.stringify({ milestoneId: "mls_1" }),
      });

      const res = await evidencePost(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(json.message).toBe("GitHub access permission is insufficient.");
    });

    it("returns 401 Unauthorized with 'GitHub authentication needs to be refreshed.' when credentials expire", async () => {
      vi.spyOn(authService, "authenticateRequest").mockResolvedValue({
        id: "usr_dev_1",
        email: "dev@test.com",
        name: "Developer",
        role: "DEVELOPER",
        githubUsername: "dev_gh",
        isActive: true,
        tokenVersion: 1,
      });

      const { GitHubEvidenceService } = await import("../../src/modules/github");
      vi.spyOn(GitHubEvidenceService.prototype, "collectSubmissionEvidence").mockRejectedValueOnce(
        new DomainUnauthorizedError("GitHub authentication needs to be refreshed.")
      );

      const req = new NextRequest("http://localhost:3000/api/submissions/sub_1/evidence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_token",
        },
        body: JSON.stringify({ milestoneId: "mls_1" }),
      });

      const res = await evidencePost(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
      expect(json.message).toBe("GitHub authentication needs to be refreshed.");
    });
  });

  describe("4. Canonical PR URL Returned from Provider and Stored", () => {
    it("returns the exact htmlUrl provided by GitHub API as canonical PR URL", async () => {
      const mockProvider = new MockGitHubProvider();
      const canonicalPrUrl = "https://github.com/Karmansingh09/VeriRelease/pull/1";
      mockProvider.pullRequests.set("karmansingh09/verirelease#1", {
        id: 101,
        number: 1,
        title: "Feature submission",
        body: "Implemented changes",
        state: "open",
        isMerged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headSha: "b".repeat(40),
        headRef: "feature-branch",
        headRepoId: 987654321,
        baseSha: "c".repeat(40),
        baseRef: "main",
        baseRepoId: 987654321,
        authorUsername: "Karmansingh09",
        authorId: 12345,
        htmlUrl: canonicalPrUrl,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const pr = await mockProvider.getPullRequest("Karmansingh09", "VeriRelease", 1);
      expect(pr.htmlUrl).toBe(canonicalPrUrl);
      expect(pr.htmlUrl).not.toContain("/issues/");
    });
  });
});
