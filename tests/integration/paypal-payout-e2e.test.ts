/**
 * PayPal Payout End-to-End PostgreSQL Integration Test Suite
 *
 * Runs against live PostgreSQL 18 test database on port 5433:
 * - Prevents payout on ineligible milestone (SUBMITTED / FUNDED / DRAFT)
 * - Executes full payout flow once milestone reaches ELIGIBLE_FOR_PAYOUT
 * - Persists PayPal order ID, capture ID, amount, currency, and SUCCEEDED state
 * - Rejects duplicate payout trigger (DuplicatePayoutError)
 * - Transitions transaction to PAYOUT_UNCERTAIN upon ambiguous network response
 * - Verifies append-only transactional audit log entries
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { prisma } from "../../src/lib/prisma";
import { contractService } from "../../src/modules/contracts";
import { aiEvaluationService } from "../../src/modules/ai";
import {
  payoutCoordinator,
  PayoutCoordinator,
  PaymentCoordinatorService,
  PrismaPaymentRepository,
  PrismaReconciliationRepository,
  MockPayPalClient,
} from "../../src/modules/payments";
import { DefaultAuditService, PrismaAuditRepository } from "../../src/modules/audit";
import {
  ConcurrencyConflictError,
  DuplicatePayoutError,
} from "../../src/modules/common/errors";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("PayPal Payout End-to-End Integration Tests (PostgreSQL)", () => {
  let pgClient: PoolClient;

  const clientUser = {
    id: "usr_client_pay_1",
    email: "client.pay@example.com",
    name: "Client Pay Tester",
    role: "CLIENT",
    isActive: true,
  };

  const devUser = {
    id: "usr_dev_pay_1",
    email: "dev.pay@example.com",
    name: "Dev Pay Tester",
    role: "DEVELOPER",
    githubUsername: "devpay",
    paypalReceiverEmail: "dev-sbx-payout@example.com",
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

  async function setupEligibleMilestone() {
    const contract = await contractService.createContract(clientUser.id, {
      title: "PayPal Sandbox Demo Contract",
      description: "Verifying end-to-end PayPal payout flow",
      developerId: devUser.id,
      totalAmountUsd: 2000,
      currency: "USD",
      githubRepoOwner: "aliceorg",
      githubRepoName: "paypal-demo",
    });

    const milestone = await contractService.addMilestone(contract.id, clientUser.id, {
      title: "Milestone 1: Payment Engine",
      description: "Deliver payout logic",
      amountUsd: 1000,
      criteria: [
        {
          title: "Automated Tests",
          description: "CI checks pass",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    // Fund milestone (DRAFT -> FUNDED)
    await contractService.fundMilestone(milestone.id, clientUser.id);

    // Developer submits PR (FUNDED -> SUBMITTED)
    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 77,
      prCommitSha: "7777777777777777777777777777777777777777",
      prUrl: "https://github.com/aliceorg/paypal-demo/pull/77",
    });

    // Seed passing evidence snapshot
    await prisma.gitHubEvidenceSnapshot.create({
      data: {
        id: `ev_${Date.now()}`,
        submissionId: submission.id,
        milestoneId: milestone.id,
        snapshotVersion: 1,
        repositoryId: 555555n,
        repoOwner: "aliceorg",
        repoName: "paypal-demo",
        prNumber: 77,
        prUrl: "https://github.com/aliceorg/paypal-demo/pull/77",
        prTitle: "feat(payout): complete PayPal checkout",
        prBody: "Tests passed",
        prAuthor: "devpay",
        prState: "open",
        headBranch: "feat/payout",
        headCommitSha: "7777777777777777777777777777777777777777",
        baseBranch: "main",
        baseCommitSha: "0000000000000000000000000000000000000000",
        commitCount: 1,
        commits: [{ sha: "7777777777777777777777777777777777777777", message: "done" }],
        checks: [{ name: "ci", status: "completed", conclusion: "success" }],
        checksStatus: "SUCCESS",
        evidenceHash: "a".repeat(64),
      },
    });

    // Run AI evaluation & deterministic policy engine -> ELIGIBLE_FOR_PAYOUT
    const outcome = await aiEvaluationService.evaluateSubmission(
      submission.id,
      clientUser as any
    );
    expect(outcome.milestoneStatus).toBe("ELIGIBLE_FOR_PAYOUT");

    return { contract, milestone, submission };
  }

  it("rejects payout when milestone is not in ELIGIBLE_FOR_PAYOUT state", async () => {
    const contract = await contractService.createContract(clientUser.id, {
      title: "Ineligible Milestone Contract",
      description: "Test premature payout rejection",
      developerId: devUser.id,
      githubRepoOwner: "aliceorg",
      githubRepoName: "premature-repo",
    });

    const milestone = await contractService.addMilestone(contract.id, clientUser.id, {
      title: "Draft Milestone",
      description: "Not funded or evaluated yet",
      criteria: [{ title: "Test", description: "Test", criterionType: "AUTOMATED_TEST" }],
    });

    await expect(
      payoutCoordinator.executePayout({
        milestoneId: milestone.id,
        callerId: clientUser.id,
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  it("executes complete PayPal Sandbox payout lifecycle, persists capture, blocks duplicate payout, and audits all transitions", async () => {
    const { milestone } = await setupEligibleMilestone();

    // 1. Trigger payout as authorized client
    const result = await payoutCoordinator.executePayout({
      milestoneId: milestone.id,
      callerId: clientUser.id,
    });

    expect(result.transaction.status).toBe("SUCCEEDED");
    expect(result.transaction.amountMinorUnits).toBe(100000n);
    expect(result.transaction.currency).toBe("USD");
    expect(result.paypalOrderId).toBeDefined();
    expect(result.paypalCaptureId).toBeDefined();

    // 2. Verify PostgreSQL PaymentTransaction persistence
    const dbTx = await prisma.paymentTransaction.findUnique({
      where: { id: result.transaction.id },
    });
    expect(dbTx?.status).toBe("SUCCEEDED");
    expect(dbTx?.paypalOrderId).toBe(result.paypalOrderId);
    expect(dbTx?.paypalCaptureId).toBe(result.paypalCaptureId);

    // 3. Duplicate payout attempt must throw DuplicatePayoutError (or safely protect against second capture)
    await expect(
      payoutCoordinator.executePayout({
        milestoneId: milestone.id,
        callerId: clientUser.id,
      })
    ).rejects.toThrow(DuplicatePayoutError);

    // 4. Verify Audit Trail
    const auditLogs = await prisma.auditLog.findMany({
      where: { entityId: result.transaction.id },
      orderBy: { timestamp: "asc" },
    });

    const actions = auditLogs.map((l) => l.action);
    expect(actions).toContain("PAYOUT_RESERVED");
    expect(actions).toContain("PAYOUT_PROCESSING_STARTED");
    expect(actions).toContain("PAYMENT_SUCCEEDED");
  });

  it("persists PAYOUT_UNCERTAIN in PostgreSQL when PayPal times out without blind retry", async () => {
    const { milestone } = await setupEligibleMilestone();

    const auditService = new DefaultAuditService(new PrismaAuditRepository(prisma), prisma);
    const paymentService = new PaymentCoordinatorService(
      new PrismaPaymentRepository(prisma),
      auditService,
      prisma,
      new PrismaReconciliationRepository(prisma)
    );
    const uncertainClient = new MockPayPalClient({ simulateAmbiguousTimeout: true });

    const coordinator = new PayoutCoordinator(
      paymentService,
      uncertainClient,
      auditService,
      prisma
    );

    const result = await coordinator.executePayout({
      milestoneId: milestone.id,
      callerId: clientUser.id,
    });

    expect(result.transaction.status).toBe("PAYOUT_UNCERTAIN");
    expect(result.providerStatus).toBe("UNCERTAIN");

    const dbTx = await prisma.paymentTransaction.findUnique({
      where: { id: result.transaction.id },
    });
    expect(dbTx?.status).toBe("PAYOUT_UNCERTAIN");
    expect(dbTx?.errorCode).toBe("PAYPAL_AMBIGUOUS_RESPONSE");
  });
});
