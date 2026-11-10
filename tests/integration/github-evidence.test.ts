/**
 * VeriRelease Milestone 3: GitHub Evidence & Webhooks Integration Test Suite
 *
 * Verifies real database constraints, immutability triggers, composite foreign keys,
 * role permissions, webhook persistence, duplicate handling, concurrent safety,
 * strict isolation guards, and evidence collection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { createHmac } from "node:crypto";
import { prisma } from "../../src/lib/prisma";
import {
  MockGitHubProvider,
  GitHubRepoService,
  WebhookDeliveryService,
  GitHubEvidenceService,
  PrismaGitHubRepository,
  PrismaWebhookDeliveryRepository,
  PrismaEvidenceRepository,
} from "../../src/modules/github";
import { TransactionalAuditService } from "../../src/modules/audit/audit-service";
import { PrismaSubmissionRepository } from "../../src/modules/contracts/prisma-submission-repository";
import {
  DomainForbiddenError,
  DomainValidationError,
} from "../../src/modules/common/errors";
import type { AuthenticatedUser } from "../../src/modules/auth/types";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("GitHub Integration & Evidence Ingestion PostgreSQL Test Suite", () => {
  let client: PoolClient;
  let mockProvider: MockGitHubProvider;
  let repoService: GitHubRepoService;
  let webhookService: WebhookDeliveryService;
  let evidenceService: GitHubEvidenceService;
  let submissionRepo: PrismaSubmissionRepository;

  const webhookSecret = "integration_test_secret_key_123456";

  function sign(body: string): string {
    return `sha256=${createHmac("sha256", webhookSecret).update(Buffer.from(body, "utf8")).digest("hex")}`;
  }

  beforeAll(async () => {
    client = await pool.connect();
    mockProvider = new MockGitHubProvider();
    const auditService = new TransactionalAuditService(undefined, prisma);
    const repoRepository = new PrismaGitHubRepository(prisma);
    const deliveryRepository = new PrismaWebhookDeliveryRepository(prisma);
    const evidenceRepository = new PrismaEvidenceRepository(prisma);

    repoService = new GitHubRepoService(mockProvider, repoRepository, auditService, prisma);
    webhookService = new WebhookDeliveryService(deliveryRepository, auditService, prisma);
    evidenceService = new GitHubEvidenceService(mockProvider, evidenceRepository, auditService, prisma);
    submissionRepo = new PrismaSubmissionRepository(prisma);
  });

  afterAll(async () => {
    if (client) client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query(`
      SET ROLE postgres;
      TRUNCATE TABLE
        "GitHubEvidenceSnapshot",
        "GitHubWebhookDelivery",
        "Contract",
        "GitHubRepository",
        "PaymentReconciliation",
        "AuditLog",
        "PaymentTransaction",
        "PolicyEvaluation",
        "MilestoneSubmission",
        "AcceptanceCriterion",
        "Milestone",
        "User"
      CASCADE;
    `);

    // Reset mock provider state
    mockProvider.installations.clear();
    mockProvider.repositories.clear();
    mockProvider.pullRequests.clear();
    mockProvider.pullRequestCommits.clear();
    mockProvider.commits.clear();
    mockProvider.checks.clear();
  });

  // Helper to seed a basic contract, client, developer, and funded milestone with criteria
  async function seedTestContractAndMilestone(): Promise<{
    clientId: string;
    devId: string;
    clientUser: AuthenticatedUser;
    devUser: AuthenticatedUser;
    outsiderUser: AuthenticatedUser;
    contractId: string;
    milestoneId: string;
  }> {
    const clientId = "usr_client_m3";
    const devId = "usr_dev_m3";
    const outsiderId = "usr_outsider_m3";
    const contractId = "cnt_m3_001";
    const milestoneId = "mls_m3_001";

    await client.query(`
      INSERT INTO "User" (id, email, name, role, "githubUsername", "isActive", "tokenVersion")
      VALUES 
        ('${clientId}', 'client.m3@test.com', 'M3 Client', 'CLIENT', 'client_gh', true, 1),
        ('${devId}', 'dev.m3@test.com', 'M3 Developer', 'DEVELOPER', 'dev_gh', true, 1),
        ('${outsiderId}', 'outsider.m3@test.com', 'M3 Outsider', 'DEVELOPER', 'outsider_gh', true, 1);
    `);

    await client.query(`
      INSERT INTO "Contract" (id, title, description, "clientId", "developerId", "totalAmountMinorUnits", currency, "githubRepoOwner", "githubRepoName")
      VALUES 
        ('${contractId}', 'M3 Contract', 'Desc', '${clientId}', '${devId}', 1000000, 'USD', 'acme', 'repo');
    `);

    await client.query(`
      INSERT INTO "Milestone" (id, "contractId", title, description, "orderIndex", "amountMinorUnits", currency, status, "activeCriteriaVersion")
      VALUES 
        ('${milestoneId}', '${contractId}', 'Milestone 1', 'Desc', 1, 500000, 'USD', 'FUNDED', 1);
    `);

    await client.query(`
      INSERT INTO "AcceptanceCriterion" (id, "milestoneId", version, "orderIndex", title, description, "criterionType", "isMandatory")
      VALUES
        ('crit_m3_1', '${milestoneId}', 1, 1, 'Core Feature', 'Spec', 'AUTOMATED_TEST', true);
    `);

    const clientUser: AuthenticatedUser = {
      id: clientId,
      email: "client.m3@test.com",
      name: "M3 Client",
      role: "CLIENT",
      githubUsername: "client_gh",
      isActive: true,
      tokenVersion: 1,
    };

    const devUser: AuthenticatedUser = {
      id: devId,
      email: "dev.m3@test.com",
      name: "M3 Developer",
      role: "DEVELOPER",
      githubUsername: "dev_gh",
      isActive: true,
      tokenVersion: 1,
    };

    const outsiderUser: AuthenticatedUser = {
      id: outsiderId,
      email: "outsider.m3@test.com",
      name: "M3 Outsider",
      role: "DEVELOPER",
      githubUsername: "outsider_gh",
      isActive: true,
      tokenVersion: 1,
    };

    return { clientId, devId, clientUser, devUser, outsiderUser, contractId, milestoneId };
  }

  // 1. Repository Association & Authorization
  it("Requirement 1: Authorizes contract parties to link repository using stable numeric repoId and emits audit log", async () => {
    const { devUser, contractId } = await seedTestContractAndMilestone();

    // Register installation and repo in mock provider
    mockProvider.installations.set("acme/veri-release", {
      id: 991122,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });

    mockProvider.repositories.set("acme/veri-release", {
      id: 888999,
      owner: "acme",
      name: "veri-release",
      fullName: "acme/veri-release",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/veri-release",
      description: "Official VeriRelease repo",
    });

    // Developer links the repository
    const repo = await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "veri-release",
      authenticatedUser: devUser,
    });

    expect(repo.repoId).toBe(888999n);
    expect(repo.fullName).toBe("acme/veri-release");
    expect(repo.installationId).toBe(991122n);

    // Verify contract has updated githubRepoId
    const contractRow = await client.query(`SELECT "githubRepoId", "githubRepoOwner", "githubRepoName" FROM "Contract" WHERE id = '${contractId}';`);
    expect(contractRow.rows[0].githubRepoId).toBe("888999");
    expect(contractRow.rows[0].githubRepoOwner).toBe("acme");
    expect(contractRow.rows[0].githubRepoName).toBe("veri-release");

    // Verify audit log
    const auditRes = await client.query(`
      SELECT action, "entityType", "entityId", "actorType", "actorUserId"
      FROM "AuditLog"
      WHERE "entityId" = '${contractId}' AND action = 'REPOSITORY_ASSOCIATED';
    `);
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].actorUserId).toBe(devUser.id);
  });

  it("Requirement 2: Rejects repository association if caller is not an authorized party to the contract", async () => {
    const { contractId, outsiderUser } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/veri-release", {
      id: 991122,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });

    mockProvider.repositories.set("acme/veri-release", {
      id: 888999,
      owner: "acme",
      name: "veri-release",
      fullName: "acme/veri-release",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/veri-release",
      description: "Official VeriRelease repo",
    });

    // Unauthorized outsider attempts to associate
    await expect(
      repoService.associateRepository({
        contractId,
        owner: "acme",
        repo: "veri-release",
        authenticatedUser: outsiderUser,
      })
    ).rejects.toThrow(DomainForbiddenError);
  });

  it("Requirement 2b: Rejects repository association if repository lacks an authorized GitHub App installation", async () => {
    const { devUser, contractId } = await seedTestContractAndMilestone();

    // Repo exists but NO installation is registered
    mockProvider.repositories.set("acme/uninstalled-repo", {
      id: 888999,
      owner: "acme",
      name: "uninstalled-repo",
      fullName: "acme/uninstalled-repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/uninstalled-repo",
      description: "Repo without app",
    });

    await expect(
      repoService.associateRepository({
        contractId,
        owner: "acme",
        repo: "uninstalled-repo",
        authenticatedUser: devUser,
      })
    ).rejects.toThrow(DomainForbiddenError);
  });

  it("Requirement 2c: Rejects repository association if caller has no linked githubUsername", async () => {
    const { contractId } = await seedTestContractAndMilestone();
    const userWithoutGithub: AuthenticatedUser = {
      id: "usr_dev_m3",
      email: "dev.m3@test.com",
      name: "M3 Developer",
      role: "DEVELOPER",
      githubUsername: null,
      isActive: true,
      tokenVersion: 1,
    };

    mockProvider.installations.set("acme/veri-release", {
      id: 991122,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });

    await expect(
      repoService.associateRepository({
        contractId,
        owner: "acme",
        repo: "veri-release",
        authenticatedUser: userWithoutGithub,
      })
    ).rejects.toThrow(/linked githubUsername/i);
  });

  it("Requirement 2d: Rejects repository association if caller lacks administrative or write permission on repository", async () => {
    const { devUser, contractId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/veri-release", {
      id: 991122,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    // Set permission to read only
    mockProvider.userPermissions.set("acme/veri-release:dev_gh", "read");

    await expect(
      repoService.associateRepository({
        contractId,
        owner: "acme",
        repo: "veri-release",
        authenticatedUser: devUser,
      })
    ).rejects.toThrow(/lacks administrative or write permissions/i);
  });

  // 2. Webhook Ingestion, Deduplication & Atomic Delivery
  it("Requirement 3: Ingests valid webhook delivery durably and detects duplicate deliveries idempotently", async () => {
    const deliveryId = "del_pg_001";
    const payloadStr = JSON.stringify({
      action: "opened",
      number: 101,
      repository: { id: 888999, full_name: "acme/veri-release" },
    });
    const signature = sign(payloadStr);

    // First ingestion
    const firstResult = await webhookService.ingestWebhook({
      rawBody: payloadStr,
      signatureHeader: signature,
      deliveryId,
      eventType: "pull_request",
      webhookSecret,
    });

    expect(firstResult.outcome).toBe("accepted");
    expect(firstResult.delivery.deliveryId).toBe(deliveryId);
    expect(firstResult.delivery.status).toBe("RECEIVED");

    // Idempotent duplicate ingestion
    const secondResult = await webhookService.ingestWebhook({
      rawBody: payloadStr,
      signatureHeader: signature,
      deliveryId,
      eventType: "pull_request",
      webhookSecret,
    });

    expect(secondResult.outcome).toBe("duplicate");
    expect(secondResult.delivery.deliveryId).toBe(deliveryId);

    // Verify exactly one row in DB
    const dbRows = await client.query(`
      SELECT count(*) as count FROM "GitHubWebhookDelivery" WHERE "deliveryId" = '${deliveryId}';
    `);
    expect(parseInt(dbRows.rows[0].count, 10)).toBe(1);
  });

  it("Requirement 3b: Concurrent duplicate webhook delivery race condition safely resolves without 500 error", async () => {
    const deliveryId = "del_pg_concurrent_001";
    const payloadStr = JSON.stringify({
      action: "synchronize",
      number: 101,
      repository: { id: 888999, full_name: "acme/veri-release" },
    });
    const signature = sign(payloadStr);

    // Launch 3 simultaneous ingest calls for the exact same delivery ID
    const promises = [
      webhookService.ingestWebhook({
        rawBody: payloadStr,
        signatureHeader: signature,
        deliveryId,
        eventType: "pull_request",
        webhookSecret,
      }),
      webhookService.ingestWebhook({
        rawBody: payloadStr,
        signatureHeader: signature,
        deliveryId,
        eventType: "pull_request",
        webhookSecret,
      }),
      webhookService.ingestWebhook({
        rawBody: payloadStr,
        signatureHeader: signature,
        deliveryId,
        eventType: "pull_request",
        webhookSecret,
      }),
    ];

    const results = await Promise.all(promises);

    // Exactly one should be "accepted" and the others "duplicate"
    const acceptedCount = results.filter((r) => r.outcome === "accepted").length;
    const duplicateCount = results.filter((r) => r.outcome === "duplicate").length;

    expect(acceptedCount).toBe(1);
    expect(duplicateCount).toBe(2);

    // Exactly one delivery persisted
    const dbCount = await client.query(`
      SELECT count(*) as count FROM "GitHubWebhookDelivery" WHERE "deliveryId" = '${deliveryId}';
    `);
    expect(parseInt(dbCount.rows[0].count, 10)).toBe(1);
  });

  it("Requirement 3c: Webhook signature verification failure does NOT insert rows into database AuditLog table", async () => {
    const deliveryId = "del_pg_bad_sig_001";
    const payloadStr = JSON.stringify({ action: "opened" });
    const invalidSig = "sha256=" + "0".repeat(64);

    await expect(
      webhookService.ingestWebhook({
        rawBody: payloadStr,
        signatureHeader: invalidSig,
        deliveryId,
        eventType: "pull_request",
        webhookSecret,
      })
    ).rejects.toThrow();

    // Verify 0 rows in AuditLog for this delivery
    const auditRes = await client.query(`
      SELECT count(*) as count FROM "AuditLog" WHERE "entityId" = '${deliveryId}';
    `);
    expect(parseInt(auditRes.rows[0].count, 10)).toBe(0);
  });

  it("Requirement 3d: Concurrent delivery with conflicting payload hash throws ConcurrencyConflictError without aborting Postgres connection", async () => {
    const deliveryId = "del_pg_concurrent_conflict_001";
    const payload1 = JSON.stringify({ action: "opened", number: 101, repo: "acme/repo" });
    const payload2 = JSON.stringify({ action: "closed", number: 101, repo: "acme/repo" }); // Different payload!
    const sig1 = sign(payload1);
    const sig2 = sign(payload2);

    // Ingest first delivery
    const res1 = await webhookService.ingestWebhook({
      rawBody: payload1,
      signatureHeader: sig1,
      deliveryId,
      eventType: "pull_request",
      webhookSecret,
    });
    expect(res1.outcome).toBe("accepted");

    // Second delivery with same delivery ID but different payload hash must throw ConcurrencyConflictError
    await expect(
      webhookService.ingestWebhook({
        rawBody: payload2,
        signatureHeader: sig2,
        deliveryId,
        eventType: "pull_request",
        webhookSecret,
      })
    ).rejects.toThrow(/conflicting payload hash/i);

    // Verify subsequent database query on client succeeds (no transaction abort remains)
    const checkRes = await client.query(`
      SELECT "deliveryId", "payloadHash" FROM "GitHubWebhookDelivery" WHERE "deliveryId" = '${deliveryId}';
    `);
    expect(checkRes.rows.length).toBe(1);
  });

  it("Requirement 4: Delivery state transition updates status and processed timestamp", async () => {
    const deliveryId = "del_pg_002";
    const payloadStr = JSON.stringify({ action: "closed" });
    const signature = sign(payloadStr);

    await webhookService.ingestWebhook({
      rawBody: payloadStr,
      signatureHeader: signature,
      deliveryId,
      eventType: "pull_request",
      webhookSecret,
    });

    const updated = await webhookService.updateDeliveryStatus(deliveryId, "PROCESSED");
    expect(updated.status).toBe("PROCESSED");
    expect(updated.processedAt).not.toBeNull();

    const dbRow = await client.query(`
      SELECT status, "processedAt" FROM "GitHubWebhookDelivery" WHERE "deliveryId" = '${deliveryId}';
    `);
    expect(dbRow.rows[0].status).toBe("PROCESSED");
    expect(dbRow.rows[0].processedAt).not.toBeNull();
  });

  // 3. Evidence Ingestion & Snapshot Binding
  it("Requirement 5: Collects PR evidence, computes canonical evidenceHash, and binds immutable snapshot to submission", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    // 1. Link repository
    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    // 2. Developer submits PR
    const commitSha = "1111222233334444555566667777888899990000";
    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 42,
      prCommitSha: commitSha,
      prUrl: "https://github.com/acme/repo/pull/42",
      submittedById: devUser.id,
    });

    // 3. Configure mock PR, commit, and checks in provider
    mockProvider.pullRequests.set("acme/repo#42", {
      id: 998877,
      number: 42,
      title: "Implement M1",
      body: "Closes #1",
      state: "open",
      isMerged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: commitSha,
      headRef: "feat/m1",
      headRepoId: 777111,
      baseSha: "0000111122223333444455556666777788889999",
      baseRef: "main",
      baseRepoId: 777111,
      authorUsername: "dev.m3",
      authorId: 12345,
      htmlUrl: "https://github.com/acme/repo/pull/42",
      createdAt: new Date("2026-11-05T10:00:00Z"),
      updatedAt: new Date("2026-11-05T11:00:00Z"),
    });

    mockProvider.pullRequestCommits.set("acme/repo#42", [
      {
        sha: commitSha,
        message: "feat: m1",
        authorName: "Dev",
        authorEmail: "dev@test.com",
        authoredDate: new Date("2026-11-05T10:00:00Z"),
        committerName: "Dev",
        committerEmail: "dev@test.com",
        committedDate: new Date("2026-11-05T10:00:00Z"),
        treeSha: "t".repeat(40),
        parents: [],
      },
    ]);

    mockProvider.checks.set(`acme/repo@${commitSha}`, {
      status: "SUCCESS",
      totalCount: 1,
      checkRuns: [
        {
          id: 1,
          name: "build-and-test",
          status: "completed",
          conclusion: "success",
          startedAt: new Date("2026-11-05T10:05:00Z"),
          completedAt: new Date("2026-11-05T10:10:00Z"),
          detailsUrl: "https://ci.acme.com/build/1",
        },
      ],
    });

    // 4. Ingest evidence
    const snapshot = await evidenceService.collectSubmissionEvidence({
      submissionId: submission.id,
      milestoneId,
      authenticatedUser: devUser,
    });

    expect(snapshot.submissionId).toBe(submission.id);
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.repositoryId).toBe(777111n);
    expect(snapshot.headCommitSha).toBe(commitSha);
    expect(snapshot.checksStatus).toBe("SUCCESS");
    expect(snapshot.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    // Verify snapshot in DB
    const dbSnapRes = await client.query(`
      SELECT "snapshotVersion", "headCommitSha", "evidenceHash", "checksStatus"
      FROM "GitHubEvidenceSnapshot"
      WHERE "submissionId" = '${submission.id}';
    `);
    expect(dbSnapRes.rows.length).toBe(1);
    expect(dbSnapRes.rows[0].snapshotVersion).toBe(1);
    expect(dbSnapRes.rows[0].headCommitSha).toBe(commitSha);
  });

  it("Requirement 6: Cross-repository isolation prevents PR from unauthorized repository", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    const commitSha = "a".repeat(40);
    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 99,
      prCommitSha: commitSha,
      prUrl: "https://github.com/acme/repo/pull/99",
      submittedById: devUser.id,
    });

    // PR belongs to a different target repo 999999 (attacker's fork or foreign repo)
    mockProvider.pullRequests.set("acme/repo#99", {
      id: 99,
      number: 99,
      title: "Malicious PR",
      body: "",
      state: "open",
      isMerged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: commitSha,
      headRef: "feat",
      headRepoId: 999999,
      baseSha: "b".repeat(40),
      baseRef: "main",
      baseRepoId: 999999, // Mismatched!
      authorUsername: "attacker",
      authorId: 999,
      htmlUrl: "https://github.com/acme/repo/pull/99",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      evidenceService.collectSubmissionEvidence({
        submissionId: submission.id,
        milestoneId,
        authenticatedUser: devUser,
      })
    ).rejects.toThrow("Cross-repository isolation violation");
  });

  it("Requirement 6b: Cross-repository isolation strictly rejects PR when baseRepoId is null or missing", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    const commitSha = "a".repeat(40);
    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 100,
      prCommitSha: commitSha,
      prUrl: "https://github.com/acme/repo/pull/100",
      submittedById: devUser.id,
    });

    // PR with null baseRepoId
    mockProvider.pullRequests.set("acme/repo#100", {
      id: 100,
      number: 100,
      title: "Anomalous PR",
      body: "",
      state: "open",
      isMerged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: commitSha,
      headRef: "feat",
      headRepoId: 777111,
      baseSha: "b".repeat(40),
      baseRef: "main",
      baseRepoId: null, // NULL! Must not be bypassed!
      authorUsername: "dev",
      authorId: 1,
      htmlUrl: "https://github.com/acme/repo/pull/100",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      evidenceService.collectSubmissionEvidence({
        submissionId: submission.id,
        milestoneId,
        authenticatedUser: devUser,
      })
    ).rejects.toThrow(/Cross-repository isolation violation/i);
  });

  it("Requirement 7: Commit SHA integrity check rejects PR head mismatch with submission commit SHA", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    const submittedSha = "a".repeat(40);
    const prActualHeadSha = "b".repeat(40);

    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 42,
      prCommitSha: submittedSha,
      prUrl: "https://github.com/acme/repo/pull/42",
      submittedById: devUser.id,
    });

    mockProvider.pullRequests.set("acme/repo#42", {
      id: 42,
      number: 42,
      title: "PR",
      body: "",
      state: "open",
      isMerged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: prActualHeadSha,
      headRef: "feat",
      headRepoId: 777111,
      baseSha: "c".repeat(40),
      baseRef: "main",
      baseRepoId: 777111,
      authorUsername: "dev",
      authorId: 1,
      htmlUrl: "https://github.com/acme/repo/pull/42",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      evidenceService.collectSubmissionEvidence({
        submissionId: submission.id,
        milestoneId,
        authenticatedUser: devUser,
      })
    ).rejects.toThrow("head commit SHA 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' does not match submission commit SHA");
  });

  it("Requirement 8: Composite FK prevents an evidence snapshot from referencing a mismatched milestone ID", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    const m2Id = "mls_m3_002";
    await client.query(`
      INSERT INTO "Milestone" (id, "contractId", title, description, "orderIndex", "amountMinorUnits", currency, status)
      VALUES ('${m2Id}', '${contractId}', 'M2', 'Desc', 2, 500000, 'USD', 'DRAFT');
    `);

    const sub1 = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 10,
      prCommitSha: "c".repeat(40),
      prUrl: "https://github.com/acme/repo/pull/10",
      submittedById: devUser.id,
    });

    const insertPromise = client.query(`
      INSERT INTO "GitHubEvidenceSnapshot" (
        id, "submissionId", "milestoneId", "snapshotVersion", "repositoryId",
        "repoOwner", "repoName", "prNumber", "prUrl", "prTitle", "prAuthor",
        "prState", "headBranch", "headCommitSha", "baseBranch", "baseCommitSha",
        "commitCount", commits, checks, "checksStatus", "evidenceHash"
      ) VALUES (
        'evs_mismatch', '${sub1.id}', '${m2Id}', 1, 777111,
        'acme', 'repo', 10, 'https://github.com/acme/repo/pull/10', 'Title', 'author',
        'open', 'feat', '${"c".repeat(40)}', 'main', '${"d".repeat(40)}',
        0, '[]'::jsonb, '{}'::jsonb, 'UNAVAILABLE', '${"e".repeat(64)}'
      );
    `);

    await expect(insertPromise).rejects.toThrow(/fk_evidence_submission_milestone_scoped/i);
  });

  it("Requirement 9: GitHubEvidenceSnapshot immutability trigger raises SQLSTATE 55000 on UPDATE or DELETE", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    const commitSha = "f".repeat(40);
    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 5,
      prCommitSha: commitSha,
      prUrl: "https://github.com/acme/repo/pull/5",
      submittedById: devUser.id,
    });

    mockProvider.pullRequests.set("acme/repo#5", {
      id: 5,
      number: 5,
      title: "PR 5",
      body: "",
      state: "open",
      isMerged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: commitSha,
      headRef: "feat",
      headRepoId: 777111,
      baseSha: "0".repeat(40),
      baseRef: "main",
      baseRepoId: 777111,
      authorUsername: "dev",
      authorId: 1,
      htmlUrl: "https://github.com/acme/repo/pull/5",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockProvider.pullRequestCommits.set("acme/repo#5", []);
    mockProvider.checks.set(`acme/repo@${commitSha}`, { status: "SUCCESS", totalCount: 0, checkRuns: [] });

    const snapshot = await evidenceService.collectSubmissionEvidence({
      submissionId: submission.id,
      milestoneId,
      authenticatedUser: devUser,
    });

    // Attempt UPDATE on immutable snapshot
    const updateAttempt = client.query(`
      UPDATE "GitHubEvidenceSnapshot"
      SET "prTitle" = 'Tampered Title'
      WHERE id = '${snapshot.id}';
    `);
    await expect(updateAttempt).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("GitHubEvidenceSnapshot entries are strictly append-only"),
    });

    // Attempt DELETE on immutable snapshot
    const deleteAttempt = client.query(`
      DELETE FROM "GitHubEvidenceSnapshot"
      WHERE id = '${snapshot.id}';
    `);
    await expect(deleteAttempt).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("GitHubEvidenceSnapshot entries are strictly append-only"),
    });
  });

  it("Requirement 10: Role permissions: verirelease_app_user cannot UPDATE or DELETE from GitHubEvidenceSnapshot", async () => {
    const { devUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    const commitSha = "e".repeat(40);
    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 6,
      prCommitSha: commitSha,
      prUrl: "https://github.com/acme/repo/pull/6",
      submittedById: devUser.id,
    });

    mockProvider.pullRequests.set("acme/repo#6", {
      id: 6,
      number: 6,
      title: "PR 6",
      body: "",
      state: "open",
      isMerged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: commitSha,
      headRef: "feat",
      headRepoId: 777111,
      baseSha: "0".repeat(40),
      baseRef: "main",
      baseRepoId: 777111,
      authorUsername: "dev",
      authorId: 1,
      htmlUrl: "https://github.com/acme/repo/pull/6",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockProvider.pullRequestCommits.set("acme/repo#6", []);
    mockProvider.checks.set(`acme/repo@${commitSha}`, { status: "SUCCESS", totalCount: 0, checkRuns: [] });

    const snapshot = await evidenceService.collectSubmissionEvidence({
      submissionId: submission.id,
      milestoneId,
      authenticatedUser: devUser,
    });

    // Connect as verirelease_app_user
    const appClient = await pool.connect();
    try {
      await appClient.query("SET ROLE verirelease_app_user;");

      const selectRes = await appClient.query(`
        SELECT id FROM "GitHubEvidenceSnapshot" WHERE id = '${snapshot.id}';
      `);
      expect(selectRes.rows.length).toBe(1);

      const updateAttempt = appClient.query(`
        UPDATE "GitHubEvidenceSnapshot"
        SET "prTitle" = 'Tampered'
        WHERE id = '${snapshot.id}';
      `);
      await expect(updateAttempt).rejects.toThrow(/permission denied/i);

      const deleteAttempt = appClient.query(`
        DELETE FROM "GitHubEvidenceSnapshot"
        WHERE id = '${snapshot.id}';
      `);
      await expect(deleteAttempt).rejects.toThrow(/permission denied/i);
    } finally {
      await appClient.query("RESET ROLE;");
      appClient.release();
    }
  });

  it("Requirement 11: Authorization checks reject unrelated authenticated user from retrieving repository or evidence", async () => {
    const { devUser, outsiderUser, contractId, milestoneId } = await seedTestContractAndMilestone();

    mockProvider.installations.set("acme/repo", {
      id: 777000,
      account: { id: 1, login: "acme" },
      repositorySelection: "selected",
    });
    mockProvider.repositories.set("acme/repo", {
      id: 777111,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/repo",
      description: null,
    });
    await repoService.associateRepository({
      contractId,
      owner: "acme",
      repo: "repo",
      authenticatedUser: devUser,
    });

    // Outsider cannot GET repository for contract
    await expect(
      repoService.getContractRepository(contractId, outsiderUser)
    ).rejects.toThrow(DomainForbiddenError);

    // Create submission
    const submission = await submissionRepo.createSubmission({
      milestoneId,
      prNumber: 7,
      prCommitSha: "7".repeat(40),
      prUrl: "https://github.com/acme/repo/pull/7",
      submittedById: devUser.id,
    });

    // Outsider cannot trigger evidence collection
    await expect(
      evidenceService.collectSubmissionEvidence({
        submissionId: submission.id,
        milestoneId,
        authenticatedUser: outsiderUser,
      })
    ).rejects.toThrow(DomainForbiddenError);

    // Outsider cannot view latest evidence
    await expect(
      evidenceService.getLatestEvidenceSnapshot(submission.id, outsiderUser)
    ).rejects.toThrow(DomainForbiddenError);
  });
});
