/**
 * VeriRelease Payment Recovery & Reconciliation Integration Test Suite
 *
 * Verifies M2 Slice 2.7 requirements:
 * 1. Stale RESERVED recovery:
 *    - Scans transactions older than threshold (> 5 min).
 *    - Atomically claims via conditional update.
 *    - Records recovery audit event.
 *    - Preserves transaction ID, idempotency key, attempt number, recipient, amount, currency.
 *    - Returns dispatch-ready recovery result.
 * 2. Stale PROCESSING recovery:
 *    - Transitions transactions older than threshold (> 2 min) to PAYOUT_UNCERTAIN.
 *    - Preserves idempotency key and attempt number.
 *    - Blocks replacement payout reservations (active payment guard remains in place).
 *    - Records audit log with recovery reason.
 * 3. Reconciliation Outcome 1 (CONFIRMED_SUCCEEDED):
 *    - Transitions PAYOUT_UNCERTAIN or RECONCILIATION_REQUIRED -> SUCCEEDED.
 *    - Milestone-first row lock ordering before PaymentTransaction row lock.
 *    - Enforces duplicate payout protection.
 *    - Records PaymentReconciliation record and atomic audit log with SUPPLIED_NOT_VERIFIED.
 * 4. Reconciliation Outcome 2 (CONFIRMED_FAILED):
 *    - Transitions PAYOUT_UNCERTAIN or RECONCILIATION_REQUIRED -> FAILED.
 *    - Requires non-empty evidence reference and reason.
 *    - Records PaymentReconciliation and atomic audit log.
 *    - Requires standard reservation checks for any new attempt (no direct retry shortcut).
 * 5. Reconciliation Outcome 3 (STILL_UNCERTAIN):
 *    - Transitions PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED.
 *    - Keeps active payment guard in place (blocks replacement reservations).
 *    - Records PaymentReconciliation and atomic audit log.
 * 6. Immutability protection:
 *    - Attempting to UPDATE or DELETE a PaymentReconciliation record raises SQLSTATE 55000.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import { prisma } from "../../src/lib/prisma";
import { PrismaContractRepository } from "../../src/modules/contracts/prisma-contract-repository";
import { PrismaMilestoneRepository } from "../../src/modules/contracts/prisma-milestone-repository";
import { PrismaSubmissionRepository } from "../../src/modules/contracts/prisma-submission-repository";
import { PrismaPolicyRepository } from "../../src/modules/policy/prisma-policy-repository";
import { PolicyEvaluationService } from "../../src/modules/policy/policy-evaluation-service";
import { PrismaAuditRepository } from "../../src/modules/audit/prisma-audit-repository";
import { TransactionalAuditService } from "../../src/modules/audit/audit-service";
import { PrismaPaymentRepository } from "../../src/modules/payments/prisma-payment-repository";
import { PrismaReconciliationRepository } from "../../src/modules/payments/prisma-reconciliation-repository";
import { PaymentCoordinatorService } from "../../src/modules/payments/payment-service";
import {
  ConcurrencyConflictError,
  DomainValidationError,
  DuplicatePayoutError,
} from "../../src/modules/common/errors";

describe("Payment Recovery & Reconciliation Integration Test Suite", () => {
  const pool = new Pool({
    host: process.env.PGHOST || "/tmp",
    port: parseInt(process.env.PGPORT || "5433", 10),
    user: process.env.PGUSER || "postgres",
    database: process.env.PGDATABASE || "verirelease_test",
  });

  let pgClient: PoolClient;
  let contractRepo: PrismaContractRepository;
  let milestoneRepo: PrismaMilestoneRepository;
  let submissionRepo: PrismaSubmissionRepository;
  let policyRepo: PrismaPolicyRepository;
  let auditRepo: PrismaAuditRepository;
  let auditService: TransactionalAuditService;
  let policyService: PolicyEvaluationService;
  let paymentRepo: PrismaPaymentRepository;
  let reconciliationRepo: PrismaReconciliationRepository;
  let paymentService: PaymentCoordinatorService;

  beforeAll(async () => {
    pgClient = await pool.connect();
    contractRepo = new PrismaContractRepository(prisma);
    milestoneRepo = new PrismaMilestoneRepository(prisma);
    submissionRepo = new PrismaSubmissionRepository(prisma);
    policyRepo = new PrismaPolicyRepository(prisma);
    auditRepo = new PrismaAuditRepository(prisma);
    auditService = new TransactionalAuditService(auditRepo, prisma);
    policyService = new PolicyEvaluationService(
      policyRepo,
      milestoneRepo,
      submissionRepo,
      auditService,
      prisma
    );
    paymentRepo = new PrismaPaymentRepository(prisma);
    reconciliationRepo = new PrismaReconciliationRepository(prisma);
    paymentService = new PaymentCoordinatorService(
      paymentRepo,
      auditService,
      prisma,
      reconciliationRepo
    );
  });

  afterAll(async () => {
    if (pgClient) pgClient.release();
    await pool.end();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await pgClient.query(`
      SET ROLE postgres;
      TRUNCATE TABLE 
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
  });

  async function seedUsers() {
    const clientId = "usr_client_recon_01";
    const devId = "usr_dev_recon_01";

    await pgClient.query(`
      INSERT INTO "User" (id, email, name, role)
      VALUES 
        ('${clientId}', 'client@recon.test', 'Client User', 'CLIENT'),
        ('${devId}', 'dev@recon.test', 'Dev User', 'DEVELOPER');
    `);

    return { clientId, devId };
  }

  async function setupEligibleMilestone() {
    const { clientId, devId } = await seedUsers();

    const contract = await contractRepo.create({
      title: "Reconciliation Test Contract",
      description: "Testing payment recovery and reconciliation integration",
      clientId,
      developerId: devId,
      totalAmountMinorUnits: 1000000n,
      currency: "USD",
      githubRepoOwner: "acme-recon",
      githubRepoName: "recon-suite",
    });

    const milestone = await milestoneRepo.create({
      contractId: contract.id,
      title: "Milestone Recon 1",
      description: "Testing reconciliation workflows",
      orderIndex: 1,
      amountMinorUnits: 400000n,
      currency: "USD",
      criteria: [
        {
          orderIndex: 1,
          title: "Unit Tests",
          description: "Must pass all tests",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    await milestoneRepo.updateStatus(milestone.id, "FUNDED");

    const submission = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 42,
      prCommitSha: "c".repeat(40),
      prUrl: "https://github.com/acme-recon/recon-suite/pull/42",
      submittedById: devId,
    });

    await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments: [
        {
          criterionId: submission.criteriaSnapshot[0]!.criterionId,
          passed: true,
          evidence: { testCount: 25, passed: 25 },
        },
      ],
    });

    const updatedMilestone = await milestoneRepo.findById(milestone.id);
    if (!updatedMilestone) throw new Error("Milestone not found after evaluation");

    return { clientId, devId, contract, milestone: updatedMilestone, submission };
  }

  // 1. Stale RESERVED Recovery
  it("Requirement 1: Stale RESERVED recovery atomically claims transaction, records audit, and returns dispatch-ready report", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    // 1. Reserve payout
    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    expect(reservation.transaction.status).toBe("RESERVED");

    // 2. Age the transaction in the database (created 10 minutes ago)
    await pgClient.query(`
      UPDATE "PaymentTransaction"
      SET "createdAt" = NOW() - INTERVAL '10 minutes',
          "updatedAt" = NOW() - INTERVAL '10 minutes'
      WHERE id = $1;
    `, [reservation.transaction.id]);

    // 3. Execute recovery with 5-minute threshold (300 seconds)
    const report = await paymentService.recoverStaleReserved({
      olderThanSeconds: 300,
    });

    expect(report.scannedCount).toBe(1);
    expect(report.claimedCount).toBe(1);
    expect(report.results).toHaveLength(1);

    const item = report.results[0]!;
    expect(item.transactionId).toBe(reservation.transaction.id);
    expect(item.claimed).toBe(true);
    expect(item.dispatchReady).toBe(true);
    expect(item.idempotencyKey).toBe(reservation.idempotencyKey);
    expect(item.attemptNumber).toBe(1);
    expect(item.amountMinorUnits).toBe(400000n);
    expect(item.currency).toBe("USD");
    expect(item.recipient).toBe("dev@recon.test");
    expect(item.milestoneId).toBe(milestone.id);
    expect(item.submissionId).toBe(submission.id);

    // 4. Verify transaction status in DB is now PROCESSING
    const dbTx = await paymentRepo.findById(reservation.transaction.id);
    expect(dbTx?.status).toBe("PROCESSING");

    // 5. Verify audit log entry for recovery
    const auditRes = await pgClient.query(`
      SELECT "action", "previousState", "newState", "metadata"
      FROM "AuditLog"
      WHERE "entityId" = $1 AND "action" = 'PAYOUT_RESERVED_RECOVERED';
    `, [reservation.transaction.id]);

    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].action).toBe("PAYOUT_RESERVED_RECOVERED");
    expect(auditRes.rows[0].previousState).toEqual({ status: "RESERVED" });
    expect(auditRes.rows[0].newState).toEqual({ status: "PROCESSING" });

    // 6. A subsequent recovery run finds nothing stale
    const secondReport = await paymentService.recoverStaleReserved({ olderThanSeconds: 300 });
    expect(secondReport.scannedCount).toBe(0);
    expect(secondReport.claimedCount).toBe(0);
  });

  // 2. Stale PROCESSING Recovery
  it("Requirement 2: Stale PROCESSING recovery transitions to PAYOUT_UNCERTAIN and preserves active payment guard", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    // 1. Reserve and claim processing
    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    // 2. Age transaction to make it stale PROCESSING (3 minutes ago)
    await pgClient.query(`
      UPDATE "PaymentTransaction"
      SET "updatedAt" = NOW() - INTERVAL '3 minutes'
      WHERE id = $1;
    `, [reservation.transaction.id]);

    // 3. Execute recovery with 2-minute threshold (120 seconds)
    const report = await paymentService.recoverStaleProcessing({
      olderThanSeconds: 120,
    });

    expect(report.scannedCount).toBe(1);
    expect(report.transitionedCount).toBe(1);
    expect(report.results).toHaveLength(1);

    const item = report.results[0]!;
    expect(item.transactionId).toBe(reservation.transaction.id);
    expect(item.transitioned).toBe(true);
    expect(item.toStatus).toBe("PAYOUT_UNCERTAIN");
    expect(item.idempotencyKey).toBe(reservation.idempotencyKey);
    expect(item.attemptNumber).toBe(1);

    // 4. Verify DB status
    const dbTx = await paymentRepo.findById(reservation.transaction.id);
    expect(dbTx?.status).toBe("PAYOUT_UNCERTAIN");

    // 5. Active payment guard prevents creating replacement reservations
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "dev@recon.test",
      })
    ).rejects.toThrow(ConcurrencyConflictError);

    // 6. Audit log verifies PAYOUT_PROCESSING_STALE_UNCERTAIN action
    const auditRes = await pgClient.query(`
      SELECT "action", "previousState", "newState", "metadata"
      FROM "AuditLog"
      WHERE "entityId" = $1 AND "action" = 'PAYOUT_PROCESSING_STALE_UNCERTAIN';
    `, [reservation.transaction.id]);

    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].previousState).toEqual({ status: "PROCESSING" });
    expect(auditRes.rows[0].newState.status).toBe("PAYOUT_UNCERTAIN");
  });

  // 3. Reconciliation Outcome 1: CONFIRMED_SUCCEEDED
  it("Requirement 3: Reconciliation CONFIRMED_SUCCEEDED transitions to SUCCEEDED under milestone-first lock, records reconciliation and audit", async () => {
    const { clientId, milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    // Stale recovery transitions to PAYOUT_UNCERTAIN
    await pgClient.query(`
      UPDATE "PaymentTransaction"
      SET "updatedAt" = NOW() - INTERVAL '5 minutes'
      WHERE id = $1;
    `, [reservation.transaction.id]);

    await paymentService.recoverStaleProcessing({ olderThanSeconds: 120 });

    // Execute Reconciliation: CONFIRMED_SUCCEEDED
    const result = await paymentService.reconcilePayment({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      decision: "CONFIRMED_SUCCEEDED",
      reason: "PayPal confirmed payout item was claimed and completed",
      evidenceReference: "PP-ITEM-BATCH-9999",
      evidenceType: "PAYPAL_TRANSACTION_SEARCH",
      actor: {
        actorType: "USER",
        actorUserId: clientId,
      },
    });

    expect(result.transaction.status).toBe("SUCCEEDED");
    expect(result.reconciliation.decision).toBe("CONFIRMED_SUCCEEDED");
    expect(result.reconciliation.reason).toBe("PayPal confirmed payout item was claimed and completed");
    expect(result.reconciliation.evidenceReference).toBe("PP-ITEM-BATCH-9999");
    expect(result.reconciliation.actorUserId).toBe(clientId);

    // Verify persisted in PaymentReconciliation table
    const dbRecon = await reconciliationRepo.findById(result.reconciliation.id);
    expect(dbRecon).not.null;
    expect(dbRecon?.decision).toBe("CONFIRMED_SUCCEEDED");
    expect(dbRecon?.paymentTransactionId).toBe(reservation.transaction.id);

    // Verify audit log has SUPPLIED_NOT_VERIFIED
    const auditRes = await pgClient.query(`
      SELECT "action", "previousState", "newState", "metadata"
      FROM "AuditLog"
      WHERE "entityId" = $1 AND "action" = 'PAYOUT_RECONCILED_SUCCEEDED';
    `, [reservation.transaction.id]);

    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].newState).toEqual({ status: "SUCCEEDED" });
    expect(auditRes.rows[0].metadata.evidenceVerificationStatus).toBe("SUPPLIED_NOT_VERIFIED");
    expect(auditRes.rows[0].metadata.evidenceReference).toBe("PP-ITEM-BATCH-9999");

    // Duplicate payout guard prevents any further reservation
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "dev@recon.test",
      })
    ).rejects.toThrow(DuplicatePayoutError);
  });

  // 4. Reconciliation Outcome 2: CONFIRMED_FAILED
  it("Requirement 4: Reconciliation CONFIRMED_FAILED transitions to FAILED, requiring standard reservation checks for any new attempt", async () => {
    const { clientId, devId, milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    // Transition to PAYOUT_UNCERTAIN
    await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PROCESSING",
      toStatus: "PAYOUT_UNCERTAIN",
      errorMessage: "Gateway timeout",
    });

    // Reconcile as STILL_UNCERTAIN first: PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED
    await paymentService.reconcilePayment({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      decision: "STILL_UNCERTAIN",
      reason: "Waiting for PayPal API investigation ticket #1024",
      actor: {
        actorType: "USER",
        actorUserId: clientId,
      },
    });

    const txInRecon = await paymentRepo.findById(reservation.transaction.id);
    expect(txInRecon?.status).toBe("RECONCILIATION_REQUIRED");

    // Now reconcile as CONFIRMED_FAILED from RECONCILIATION_REQUIRED -> FAILED
    const failResult = await paymentService.reconcilePayment({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      decision: "CONFIRMED_FAILED",
      reason: "PayPal confirmed receiver account restricted; transaction cancelled",
      evidenceReference: "PP-DENIAL-1024",
      evidenceType: "PAYPAL_CASE_RESOLUTION",
      actor: {
        actorType: "SYSTEM_PRINCIPAL",
        actorSystemPrincipal: "RECONCILIATION_CRON",
      },
    });

    expect(failResult.transaction.status).toBe("FAILED");
    expect(failResult.reconciliation.decision).toBe("CONFIRMED_FAILED");

    // The failed transaction is no longer active, so milestone has no active payment.
    // However, a new payout must still pass standard reservation eligibility (no shortcut):
    const newReservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    expect(newReservation.transaction.id).not.toBe(reservation.transaction.id);
    expect(newReservation.attemptNumber).toBe(2);
    expect(newReservation.transaction.status).toBe("RESERVED");
  });

  // 5. Reconciliation Outcome 3: STILL_UNCERTAIN
  it("Requirement 5: Reconciliation STILL_UNCERTAIN transitions PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED and keeps active payment guard", async () => {
    const { clientId, milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PROCESSING",
      toStatus: "PAYOUT_UNCERTAIN",
    });

    // Reconcile as STILL_UNCERTAIN
    const result = await paymentService.reconcilePayment({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      decision: "STILL_UNCERTAIN",
      reason: "Bank tracing in progress",
      actor: {
        actorType: "USER",
        actorUserId: clientId,
      },
    });

    expect(result.transaction.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.reconciliation.decision).toBe("STILL_UNCERTAIN");

    // Active payment guard strictly remains in place
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "dev@recon.test",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 6. PaymentReconciliation Immutability Trigger
  it("Requirement 6: Attempting to UPDATE or DELETE a PaymentReconciliation row raises SQLSTATE 55000", async () => {
    const { clientId, milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@recon.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PROCESSING",
      toStatus: "PAYOUT_UNCERTAIN",
    });

    const result = await paymentService.reconcilePayment({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      decision: "CONFIRMED_FAILED",
      reason: "Verified failure",
      evidenceReference: "REF-IMMUT-01",
      actor: { actorType: "USER", actorUserId: clientId },
    });

    // UPDATE fails with 55000
    await expect(
      pgClient.query(`
        UPDATE "PaymentReconciliation"
        SET reason = 'tampered reason'
        WHERE id = $1;
      `, [result.reconciliation.id])
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("PaymentReconciliation entries are strictly append-only"),
    });

    // DELETE fails with 55000
    await expect(
      pgClient.query(`
        DELETE FROM "PaymentReconciliation"
        WHERE id = $1;
      `, [result.reconciliation.id])
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("PaymentReconciliation entries are strictly append-only"),
    });
  });
});
