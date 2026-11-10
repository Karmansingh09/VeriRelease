import { describe, it, expect } from "vitest";
import { hashCanonicalJson } from "../../src/modules/common/canonical-json";
import {
  gitHubEvidenceSnapshotSchema,
  gitHubCommitMetadataSchema,
  gitHubPullRequestDetailsSchema,
} from "../../src/modules/github/types";

describe("GitHub Evidence Normalization & Validation Unit Test Suite", () => {
  const sampleCommit = {
    sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    message: "feat: implement feature",
    authorName: "Developer",
    authorEmail: "dev@example.com",
    authoredDate: new Date("2026-11-01T12:00:00Z"),
    committerName: "Developer",
    committerEmail: "dev@example.com",
    committedDate: new Date("2026-11-01T12:00:00Z"),
    treeSha: "00112233445566778899aabbccddeeff00112233",
    parents: ["ffeeddccbbaa99887766554433221100ffeeddcc"],
  };

  const sampleEvidenceSnapshot = {
    id: "evs_001",
    submissionId: "sub_001",
    milestoneId: "mls_001",
    snapshotVersion: 1,
    repositoryId: 12345678n,
    repoOwner: "acme",
    repoName: "project-x",
    prNumber: 42,
    prId: 998877n,
    prUrl: "https://github.com/acme/project-x/pull/42",
    prTitle: "Milestone 1 Implementation",
    prBody: "Closes issue #10",
    prAuthor: "developer-bob",
    prAuthorId: 54321n,
    prState: "closed",
    isMerged: true,
    mergedAt: new Date("2026-11-02T15:00:00Z"),
    mergeCommitSha: "aabbccddeeff00112233445566778899aabbccdd",
    headBranch: "feature/m1",
    headCommitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    baseBranch: "main",
    baseCommitSha: "00112233445566778899aabbccddeeff00112233",
    commitCount: 1,
    commits: [sampleCommit],
    checks: {
      status: "SUCCESS" as const,
      totalCount: 1,
      checkRuns: [
        {
          id: 1,
          name: "ci/test",
          status: "completed" as const,
          conclusion: "success" as const,
          startedAt: new Date("2026-11-02T14:50:00Z"),
          completedAt: new Date("2026-11-02T14:55:00Z"),
          detailsUrl: "https://ci.example.com/build/1",
        },
      ],
    },
    checksStatus: "SUCCESS" as const,
    rawPayload: { simulated: true },
    evidenceHash: "a".repeat(64),
    collectedAt: new Date("2026-11-02T15:01:00Z"),
    provider: "github",
    apiVersion: "2022-11-28",
  };

  it("validates a fully compliant evidence snapshot against Zod domain schema", () => {
    const parseResult = gitHubEvidenceSnapshotSchema.safeParse(sampleEvidenceSnapshot);
    expect(parseResult.success).toBe(true);
  });

  it("rejects evidence snapshot with invalid commit SHA (not 40 hex chars)", () => {
    const invalid = {
      ...sampleEvidenceSnapshot,
      headCommitSha: "not-a-valid-sha",
    };
    const parseResult = gitHubEvidenceSnapshotSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
  });

  it("rejects evidence snapshot with invalid evidenceHash (not 64 hex chars)", () => {
    const invalid = {
      ...sampleEvidenceSnapshot,
      evidenceHash: "short-hash",
    };
    const parseResult = gitHubEvidenceSnapshotSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
  });

  it("rejects evidence snapshot with non-positive PR number", () => {
    const invalid = {
      ...sampleEvidenceSnapshot,
      prNumber: 0,
    };
    const parseResult = gitHubEvidenceSnapshotSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
  });

  it("rejects evidence snapshot with non-positive snapshotVersion", () => {
    const invalid = {
      ...sampleEvidenceSnapshot,
      snapshotVersion: -1,
    };
    const parseResult = gitHubEvidenceSnapshotSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
  });

  it("canonical JSON evidence hash is deterministic regardless of key insertion order", () => {
    const payloadA = {
      repositoryId: "12345678",
      prNumber: 42,
      headCommitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      baseCommitSha: "00112233445566778899aabbccddeeff00112233",
      isMerged: true,
      checksStatus: "SUCCESS",
    };

    const payloadB = {
      isMerged: true,
      headCommitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      checksStatus: "SUCCESS",
      prNumber: 42,
      baseCommitSha: "00112233445566778899aabbccddeeff00112233",
      repositoryId: "12345678",
    };

    const hashA = hashCanonicalJson(payloadA);
    const hashB = hashCanonicalJson(payloadB);

    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonical evidence hash coverage: altering individual check runs alters hash", () => {
    const baseCanonicalPayload = {
      apiVersion: "2022-11-28",
      baseBranch: "main",
      baseCommitSha: "00112233445566778899aabbccddeeff00112233",
      checks: {
        checkRuns: [
          {
            completedAt: "2026-11-02T14:55:00.000Z",
            conclusion: "success",
            detailsUrl: "https://ci.example.com/build/1",
            id: 1,
            name: "ci/test",
            startedAt: "2026-11-02T14:50:00.000Z",
            status: "completed",
          },
        ],
        status: "SUCCESS",
        totalCount: 1,
      },
      checksStatus: "SUCCESS",
      collectedAt: "2026-11-02T15:01:00.000Z",
      commitCount: 1,
      commits: [
        {
          authorEmail: "dev@example.com",
          authorName: "Developer",
          authoredDate: "2026-11-01T12:00:00.000Z",
          committedDate: "2026-11-01T12:00:00.000Z",
          committerEmail: "dev@example.com",
          committerName: "Developer",
          message: "feat: implement feature",
          parents: ["ffeeddccbbaa99887766554433221100ffeeddcc"],
          sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
          treeSha: "00112233445566778899aabbccddeeff00112233",
        },
      ],
      headBranch: "feature/m1",
      headCommitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      isMerged: true,
      mergeCommitSha: "aabbccddeeff00112233445566778899aabbccdd",
      mergedAt: "2026-11-02T15:00:00.000Z",
      milestoneId: "mls_001",
      prAuthor: "developer-bob",
      prAuthorId: 54321,
      prId: 998877,
      prNumber: 42,
      prState: "closed",
      prTitle: "Milestone 1 Implementation",
      prUrl: "https://github.com/acme/project-x/pull/42",
      provider: "github",
      repoName: "project-x",
      repoOwner: "acme",
      repositoryId: "12345678",
      submissionId: "sub_001",
    };

    const originalHash = hashCanonicalJson(baseCanonicalPayload);

    // 1. Changing check run conclusion changes hash
    const modifiedConclusion = JSON.parse(JSON.stringify(baseCanonicalPayload));
    modifiedConclusion.checks.checkRuns[0].conclusion = "failure";
    expect(hashCanonicalJson(modifiedConclusion)).not.toBe(originalHash);

    // 2. Changing check run name changes hash
    const modifiedName = JSON.parse(JSON.stringify(baseCanonicalPayload));
    modifiedName.checks.checkRuns[0].name = "ci/lint";
    expect(hashCanonicalJson(modifiedName)).not.toBe(originalHash);

    // 3. Changing collectedAt timestamp changes hash
    const modifiedTime = JSON.parse(JSON.stringify(baseCanonicalPayload));
    modifiedTime.collectedAt = "2026-11-02T15:02:00.000Z";
    expect(hashCanonicalJson(modifiedTime)).not.toBe(originalHash);

    // 4. Changing commit author changes hash
    const modifiedCommit = JSON.parse(JSON.stringify(baseCanonicalPayload));
    modifiedCommit.commits[0].authorEmail = "attacker@evil.com";
    expect(hashCanonicalJson(modifiedCommit)).not.toBe(originalHash);
  });

  it("validates commit metadata schema and rejects malformed parent SHAs", () => {
    const invalidCommit = {
      ...sampleCommit,
      parents: ["invalid-parent-sha"],
    };
    const parseResult = gitHubCommitMetadataSchema.safeParse(invalidCommit);
    expect(parseResult.success).toBe(false);
  });

  it("validates PR details schema and rejects invalid PR state", () => {
    const invalidPR = {
      id: 1,
      number: 1,
      title: "Title",
      state: "merged", // State in GitHub is 'open' or 'closed'
      isMerged: true,
      headSha: "a".repeat(40),
      headRef: "head",
      baseSha: "b".repeat(40),
      baseRef: "base",
      authorUsername: "user",
      authorId: 1,
      htmlUrl: "https://github.com/a/b/pull/1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const parseResult = gitHubPullRequestDetailsSchema.safeParse(invalidPR);
    expect(parseResult.success).toBe(false);
  });
});
