/**
 * AI Evaluation Pipeline PostgreSQL Integration Test Suite
 *
 * Runs against live PostgreSQL 18 test database on port 5433:
 * - End-to-end evidence normalization -> AI evaluation -> Deterministic Policy Engine -> Milestone transition
 * - Proves ELIGIBLE_FOR_PAYOUT is strictly produced by PolicyEvaluationService
 * - Proves AI evaluation NEVER creates or triggers payments
 * - Proves failing criteria transition milestone to CHANGES_REQUESTED
 * - Verifies persistent PolicyEvaluation records, cryptographic receipts, and audit logs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { prisma } from "../../src/lib/prisma";
import { contractService } from "../../src/modules/contracts";
import { aiEvaluationService } from "../../src/modules/ai";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("AI Evaluation Pipeline Integration Tests (PostgreSQL)", () => {
  let pgClient: PoolClient;

  const clientUser = {
    id: "usr_client_ai_1",
    email: "client.ai@example.com",
    name: "Client AI Tester",
    role: "CLIENT",
    isActive: true,
  };

  const devUser = {
    id: "usr_dev_ai_1",
    email: "dev.ai@example.com",
    name: "Dev AI Tester",
    role: "DEVELOPER",
    githubUsername: "devai",
    isActive: true,
  };

  beforeAll(async () => {
    pgClient = await pool.connect();
  });

  afterAll(async () => {
    if (pgClient) pgClient.release();
    await pool.end();
  });

  beforeEach(async () => {
    await pgClient.query(`
      SET ROLE postgres;
      TRUNCATE TABLE 
        "OAuthTransaction",
        "GitHubEvidenceSnapshot",
        "GitHubWebhookDelivery",
        "GitHubRepository",
        "PaymentReconciliation",
        "AuditLog", 
        "PaymentTransaction", 
        "PolicyEvaluation", 
        "MilestoneSubmission", 
        "AcceptanceCriterion", 
        "Milestone", 
        "Contract", 
        "User" 
      CASCADE;
    `);

    await prisma.user.createMany({
      data: [clientUser, devUser],
    });
  });

  it("orchestrates AI evaluation, deterministic approval, and transitions milestone to ELIGIBLE_FOR_PAYOUT without executing payment", async () => {
    // 1. Create contract and milestone
    const contract = await contractService.createContract(clientUser.id, {
      title: "AI Verification Demo Contract",
      description: "Demonstrating AI evidence evaluation",
      developerId: devUser.id,
      totalAmountUsd: 3000,
      currency: "USD",
      githubRepoOwner: "aliceorg",
      githubRepoName: "ai-verified-repo",
    });

    const milestone = await contractService.addMilestone(contract.id, clientUser.id, {
      title: "Milestone 1: Smart Webhook Filter",
      description: "Deliver filtered webhook handler",
      amountUsd: 1500,
      criteria: [
        {
          title: "Automated Tests",
          description: "All unit and integration tests pass",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
        {
          title: "Deliverable Modified",
          description: "Code modifications delivered",
          criterionType: "FILE_CHANGE",
          isMandatory: true,
        },
      ],
    });

    // 2. Fund milestone
    await contractService.fundMilestone(milestone.id, clientUser.id);

    // 3. Developer submits PR work
    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 99,
      prCommitSha: "4444444444444444444444444444444444444444",
      prUrl: "https://github.com/aliceorg/ai-verified-repo/pull/99",
    });

    // Seed passing GitHub evidence snapshot in PostgreSQL
    await prisma.gitHubEvidenceSnapshot.create({
      data: {
        id: "ev_test_passing_1",
        submissionId: submission.id,
        milestoneId: milestone.id,
        snapshotVersion: 1,
        repositoryId: 12345678n,
        repoOwner: "aliceorg",
        repoName: "ai-verified-repo",
        prNumber: 99,
        prUrl: "https://github.com/aliceorg/ai-verified-repo/pull/99",
        prTitle: "feat(filter): deliver verified webhook filter",
        prBody: "Includes automated unit and integration tests",
        prAuthor: "devai",
        prState: "open",
        headBranch: "feat/filter",
        headCommitSha: "4444444444444444444444444444444444444444",
        baseBranch: "main",
        baseCommitSha: "0000000000000000000000000000000000000000",
        commitCount: 2,
        commits: [{ sha: "4444444444444444444444444444444444444444", message: "commit 1" }],
        checks: [{ name: "test", status: "completed", conclusion: "success" }],
        checksStatus: "SUCCESS",
        evidenceHash: "e".repeat(64),
      },
    });

    // 4. Trigger AI Evaluation and Policy Engine
    const outcome = await aiEvaluationService.evaluateSubmission(submission.id, clientUser as any);

    // 5. Verify outcomes
    expect(outcome.decision).toBe("PASS");
    expect(outcome.milestoneStatus).toBe("ELIGIBLE_FOR_PAYOUT");
    expect(outcome.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.aiEvaluation.criterionAssessments).toHaveLength(2);

    // 6. Verify database state
    const dbMilestone = await prisma.milestone.findUnique({ where: { id: milestone.id } });
    expect(dbMilestone?.status).toBe("ELIGIBLE_FOR_PAYOUT");

    const policyEvaluations = await prisma.policyEvaluation.findMany({
      where: { submissionId: submission.id },
    });
    expect(policyEvaluations).toHaveLength(1);
    expect(policyEvaluations[0]?.decision).toBe("PASS");
    expect(policyEvaluations[0]?.status).toBe("COMPLETED");

    // 7. SECURITY INVARIANT: Zero payment transactions created!
    // AI and Policy Engine must NEVER authorize or execute payment directly!
    const payments = await prisma.paymentTransaction.findMany({
      where: { milestoneId: milestone.id },
    });
    expect(payments).toHaveLength(0);

    // 8. Verify audit log
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entityId: milestone.id },
          { entityId: outcome.policyEvaluation.id },
        ],
      },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
    const actions = auditLogs.map((l) => l.action);
    expect(actions).toContain("POLICY_EVALUATION_APPROVED");
    expect(actions).toContain("AI_EVALUATION_COMPLETED");
  });

  it("transitions milestone to CHANGES_REQUESTED when CI checks fail", async () => {
    const contract = await contractService.createContract(clientUser.id, {
      title: "Failing CI Contract",
      description: "Testing failing CI checks",
      developerId: devUser.id,
      githubRepoOwner: "aliceorg",
      githubRepoName: "failing-ci-repo",
    });

    const milestone = await contractService.addMilestone(contract.id, clientUser.id, {
      title: "Milestone with mandatory tests",
      description: "Fails when CI fails",
      criteria: [
        {
          title: "CI Checks",
          description: "Must pass CI",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    await contractService.fundMilestone(milestone.id, clientUser.id);

    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 101,
      prCommitSha: "5555555555555555555555555555555555555555",
      prUrl: "https://github.com/aliceorg/failing-ci-repo/pull/101",
    });

    // Seed failing evidence snapshot
    await prisma.gitHubEvidenceSnapshot.create({
      data: {
        id: "ev_test_failing_1",
        submissionId: submission.id,
        milestoneId: milestone.id,
        snapshotVersion: 1,
        repositoryId: 98765432n,
        repoOwner: "aliceorg",
        repoName: "failing-ci-repo",
        prNumber: 101,
        prUrl: "https://github.com/aliceorg/failing-ci-repo/pull/101",
        prTitle: "WIP: broken tests",
        prBody: "Tests are currently red",
        prAuthor: "devai",
        prState: "open",
        headBranch: "feat/broken",
        headCommitSha: "5555555555555555555555555555555555555555",
        baseBranch: "main",
        baseCommitSha: "0000000000000000000000000000000000000000",
        commitCount: 1,
        commits: [{ sha: "5555555555555555555555555555555555555555", message: "wip" }],
        checks: [{ name: "test", status: "completed", conclusion: "failure" }],
        checksStatus: "FAILURE",
        evidenceHash: "f".repeat(64),
      },
    });

    const outcome = await aiEvaluationService.evaluateSubmission(submission.id, clientUser as any);

    expect(outcome.decision).toBe("FAIL");
    expect(outcome.milestoneStatus).toBe("CHANGES_REQUESTED");

    const dbMilestone = await prisma.milestone.findUnique({ where: { id: milestone.id } });
    expect(dbMilestone?.status).toBe("CHANGES_REQUESTED");
  });
});
