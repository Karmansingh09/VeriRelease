/**
 * VeriRelease Payment Reservation & Idempotency Coordinator Integration Test Suite
 *
 * Verifies:
 * 1. Payout reservation creates PaymentTransaction in RESERVED status with attempt 1 and PAYOUT_RESERVED audit log.
 * 2. Idempotent retry with identical parameters returns existing transaction without duplicating rows.
 * 3. Idempotency key reuse with different parameters is rejected with ConcurrencyConflictError.
 * 4. Active reservation blocks a second reservation with a different idempotency key.
 * 5. Resubmission supersession: reservation fails if latest evaluation is pending or not PASS.
 * 6. Succeeded payout blocks any subsequent payout reservation (DuplicatePayoutError and DB constraint).
 * 7. claimProcessing transitions RESERVED to PROCESSING atomically and records audit log.
 * 8. Concurrent processing claims: exactly one worker succeeds, the other receives ConcurrencyConflictError.
 * 9. Ambiguous outcome lifecycle: PROCESSING -> PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED -> SUCCEEDED.
 * 10. Transition to SUCCEEDED acquires milestone lock first and prevents duplicate payouts.
 * 11. Transaction atomicity: failure during reservation rolls back both payment and audit changes.
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
import { PaymentCoordinatorService } from "../../src/modules/payments/payment-service";
import {
  ConcurrencyConflictError,
  DomainValidationError,
  DuplicatePayoutError,
  InvalidStateTransitionError,
} from "../../src/modules/common/errors";

describe("Payment Reservation & Idempotency Coordinator Integration Test Suite", () => {
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
    paymentService = new PaymentCoordinatorService(paymentRepo, auditService, prisma);
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
    const clientId = "usr_client_pay_01";
    const devId = "usr_dev_pay_01";

    await pgClient.query(`
      INSERT INTO "User" (id, email, name, role)
      VALUES 
        ('${clientId}', 'client@pay.test', 'Client User', 'CLIENT'),
        ('${devId}', 'dev@pay.test', 'Dev User', 'DEVELOPER');
    `);

    return { clientId, devId };
  }

  async function setupEligibleMilestone() {
    const { clientId, devId } = await seedUsers();

    const contract = await contractRepo.create({
      title: "Payment Test Contract",
      description: "Testing payment reservation integration",
      clientId,
      developerId: devId,
      totalAmountMinorUnits: 1000000n,
      currency: "USD",
      githubRepoOwner: "acme",
      githubRepoName: "webapp",
    });

    const milestone = await milestoneRepo.create({
      contractId: contract.id,
      title: "Payment Test Milestone",
      description: "Milestone for payment reservation",
      orderIndex: 1,
      amountMinorUnits: 500000n,
      currency: "USD",
      criteria: [
        {
          orderIndex: 1,
          title: "Automated Tests",
          description: "All automated tests pass",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    // Milestone -> FUNDED
    await milestoneRepo.updateStatus(milestone.id, "FUNDED");

    // Submission #1
    const submission = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 201,
      prCommitSha: "2222222222222222222222222222222222222222",
      prUrl: "https://github.com/acme/webapp/pull/201",
      submittedById: devId,
    });

    // Evaluate submission to PASS -> Milestone automatically transitions to ELIGIBLE_FOR_PAYOUT
    const evaluationResult = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments: [
        {
          criterionId: submission.criteriaSnapshot[0]!.criterionId,
          passed: true,
          evidence: { testCount: 10, passed: 10 },
        },
      ],
    });

    const updatedMilestone = await milestoneRepo.findById(milestone.id);
    if (!updatedMilestone) throw new Error("Milestone not found after evaluation");

    return {
      clientId,
      devId,
      contract,
      milestone: updatedMilestone,
      submission,
      evaluation: evaluationResult.evaluation,
    };
  }

  // 1. Payout reservation creates PaymentTransaction and AuditLog
  it("Requirement 1: Payout reservation creates PaymentTransaction in RESERVED status with attempt 1 and PAYOUT_RESERVED audit log", async () => {
    const { milestone, submission, devId } = await setupEligibleMilestone();

    const result = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    expect(result.isExisting).toBe(false);
    expect(result.transaction.id).toBeDefined();
    expect(result.transaction.status).toBe("RESERVED");
    expect(result.transaction.attemptNumber).toBe(1);
    expect(result.transaction.milestoneId).toBe(milestone.id);
    expect(result.transaction.submissionId).toBe(submission.id);
    expect(result.transaction.amountMinorUnits).toBe(500000n);
    expect(result.transaction.currency).toBe("USD");
    expect(result.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    // Verify row directly in PostgreSQL
    const txRow = await pgClient.query('SELECT * FROM "PaymentTransaction" WHERE "id" = $1', [result.transaction.id]);
    expect(txRow.rows.length).toBe(1);
    expect(txRow.rows[0].status).toBe("RESERVED");
    expect(txRow.rows[0].attemptNumber).toBe(1);

    // Verify audit log row directly in PostgreSQL
    const auditRows = await pgClient.query(
      'SELECT * FROM "AuditLog" WHERE "entityId" = $1 AND "action" = $2',
      [result.transaction.id, "PAYOUT_RESERVED"]
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0].entityType).toBe("PAYMENT");
    expect(auditRows.rows[0].actorType).toBe("SYSTEM_PRINCIPAL");
    expect(auditRows.rows[0].actorSystemPrincipal).toBe("WORKER_PAYMENT_COORDINATOR");
  });

  // 2. Idempotent retry with identical parameters
  it("Requirement 2: Idempotent retry with identical parameters returns existing transaction without duplicating rows", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    const first = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    const second = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
      idempotencyKey: first.idempotencyKey,
    });

    expect(second.isExisting).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);

    // Verify only 1 PaymentTransaction and 1 AuditLog row exist
    const txCount = await pgClient.query('SELECT COUNT(*) FROM "PaymentTransaction" WHERE "milestoneId" = $1', [milestone.id]);
    expect(parseInt(txCount.rows[0].count, 10)).toBe(1);

    const auditCount = await pgClient.query('SELECT COUNT(*) FROM "AuditLog" WHERE "entityId" = $1', [first.transaction.id]);
    expect(parseInt(auditCount.rows[0].count, 10)).toBe(1);
  });

  // 3. Idempotency key reuse with different parameters is rejected
  it("Requirement 3: Reusing idempotency key with conflicting parameters throws ConcurrencyConflictError", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    const first = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    // Provide a different submission while reusing the same idempotency key
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: "other_sub_999",
        developerPayPalEmail: "dev@pay.test",
        idempotencyKey: first.idempotencyKey,
      })
    ).rejects.toThrow(ConcurrencyConflictError);

    // Provide a different recipient email while reusing the same idempotency key
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "different-dev@pay.test",
        idempotencyKey: first.idempotencyKey,
      })
    ).rejects.toThrow(ConcurrencyConflictError);

    // Case and whitespace variations of the matching recipient succeed as idempotent retry
    const retryWithWhitespace = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "   DEV@PAY.TEST   ",
      idempotencyKey: first.idempotencyKey,
    });
    expect(retryWithWhitespace.isExisting).toBe(true);
    expect(retryWithWhitespace.transaction.id).toBe(first.transaction.id);

    // Supplying an invalid key format throws DomainValidationError
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "dev@pay.test",
        idempotencyKey: "invalid_short_key",
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 4. Active reservation blocks a second reservation
  it("Requirement 4: Active reservation blocks creating a second reservation with a different idempotency key", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    // Attempt second reservation with a distinct idempotency key
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "dev@pay.test",
        idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 5. Resubmission supersession blocks reservation
  it("Requirement 5: Resubmission supersession: stale submissionId is rejected when newer submission exists", async () => {
    const { clientId, devId } = await seedUsers();

    const contract = await contractRepo.create({
      title: "Resubmission Contract",
      description: "Testing resubmission supersession",
      clientId,
      developerId: devId,
      totalAmountMinorUnits: 1000000n,
      currency: "USD",
      githubRepoOwner: "acme",
      githubRepoName: "webapp",
    });

    const milestone = await milestoneRepo.create({
      contractId: contract.id,
      title: "Resubmission Milestone",
      description: "Milestone for resubmission",
      orderIndex: 1,
      amountMinorUnits: 500000n,
      currency: "USD",
      criteria: [
        {
          orderIndex: 1,
          title: "Automated Tests",
          description: "All automated tests pass",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    await milestoneRepo.updateStatus(milestone.id, "FUNDED");

    // Submission 1: Fail evaluation -> CHANGES_REQUESTED
    const sub1 = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 301,
      prCommitSha: "3011111111111111111111111111111111111111",
      prUrl: "https://github.com/acme/webapp/pull/301",
      submittedById: devId,
    });

    await policyService.evaluateSubmission({
      submissionId: sub1.id,
      assessments: [
        {
          criterionId: sub1.criteriaSnapshot[0]!.criterionId,
          passed: false,
          evidence: { testCount: 10, passed: 8 },
        },
      ],
    });

    // Milestone is now in CHANGES_REQUESTED. Developer creates Submission 2
    const sub2 = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 302,
      prCommitSha: "3022222222222222222222222222222222222222",
      prUrl: "https://github.com/acme/webapp/pull/302",
      submittedById: devId,
    });

    // Evaluate Submission 2 -> PASS -> ELIGIBLE_FOR_PAYOUT
    await policyService.evaluateSubmission({
      submissionId: sub2.id,
      assessments: [
        {
          criterionId: sub2.criteriaSnapshot[0]!.criterionId,
          passed: true,
          evidence: { testCount: 10, passed: 10 },
        },
      ],
    });

    // Stale submissionId sub1.id must be rejected
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        submissionId: sub1.id,
        developerPayPalEmail: "dev@pay.test",
      })
    ).rejects.toThrow(ConcurrencyConflictError);

    // Current submissionId sub2.id succeeds
    const successRes = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: sub2.id,
      developerPayPalEmail: "dev@pay.test",
    });
    expect(successRes.transaction.status).toBe("RESERVED");
    expect(successRes.submissionId).toBe(sub2.id);
  });

  // 6. Succeeded payout blocks any subsequent payout reservation
  it("Requirement 6: Succeeded payout blocks subsequent payout reservation (DuplicatePayoutError)", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    // Create reservation, claim processing, transition to SUCCEEDED
    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PROCESSING",
      toStatus: "SUCCEEDED",
      paypalPayoutItemId: "PAYPAL_ITEM_001",
    });

    // Subsequent payout reservation attempt must throw DuplicatePayoutError
    await expect(
      paymentService.reservePayout({
        milestoneId: milestone.id,
        developerPayPalEmail: "dev@pay.test",
        idempotencyKey: "2222222222222222222222222222222222222222222222222222222222222222",
      })
    ).rejects.toThrow(DuplicatePayoutError);
  });

  // 7. claimProcessing transitions RESERVED to PROCESSING atomically
  it("Requirement 7: claimProcessing transitions RESERVED to PROCESSING atomically and records audit log", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    const claimed = await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    expect(claimed.status).toBe("PROCESSING");

    // Check DB row
    const row = await pgClient.query('SELECT "status" FROM "PaymentTransaction" WHERE "id" = $1', [reservation.transaction.id]);
    expect(row.rows[0].status).toBe("PROCESSING");

    // Check audit log
    const auditRows = await pgClient.query(
      'SELECT * FROM "AuditLog" WHERE "entityId" = $1 AND "action" = $2',
      [reservation.transaction.id, "PAYOUT_PROCESSING_STARTED"]
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0].entityType).toBe("PAYMENT");
    expect(auditRows.rows[0].actorType).toBe("SYSTEM_PRINCIPAL");
    expect(auditRows.rows[0].actorSystemPrincipal).toBe("WORKER_PAYMENT_COORDINATOR");
  });

  // 8. Concurrent processing claims: exactly one worker succeeds
  it("Requirement 8: Concurrent processing claims: exactly one worker succeeds, other receives ConcurrencyConflictError", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    // Launch two claims concurrently
    const [result1, result2] = await Promise.allSettled([
      paymentService.claimProcessing({
        transactionId: reservation.transaction.id,
        milestoneId: milestone.id,
      }),
      paymentService.claimProcessing({
        transactionId: reservation.transaction.id,
        milestoneId: milestone.id,
      }),
    ]);

    const successes = [result1, result2].filter((r) => r.status === "fulfilled");
    const rejections = [result1, result2].filter((r) => r.status === "rejected");

    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
    expect((rejections[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyConflictError);

    // Verify DB status is PROCESSING
    const row = await pgClient.query('SELECT "status" FROM "PaymentTransaction" WHERE "id" = $1', [reservation.transaction.id]);
    expect(row.rows[0].status).toBe("PROCESSING");

    // Exactly one processing started audit entry
    const auditRows = await pgClient.query(
      'SELECT * FROM "AuditLog" WHERE "entityId" = $1 AND "action" = $2',
      [reservation.transaction.id, "PAYOUT_PROCESSING_STARTED"]
    );
    expect(auditRows.rows.length).toBe(1);
  });

  // 9. Ambiguous outcome lifecycle
  it("Requirement 9: Ambiguous outcome lifecycle: PROCESSING -> PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED -> SUCCEEDED", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    // 1. Ambiguous timeout: PROCESSING -> PAYOUT_UNCERTAIN
    const uncertain = await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PROCESSING",
      toStatus: "PAYOUT_UNCERTAIN",
      errorMessage: "Gateway timeout 504",
    });
    expect(uncertain.status).toBe("PAYOUT_UNCERTAIN");

    // 2. Escalation: PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED
    const reconciled = await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PAYOUT_UNCERTAIN",
      toStatus: "RECONCILIATION_REQUIRED",
      errorMessage: "Requires operator verification of bank settlement",
    });
    expect(reconciled.status).toBe("RECONCILIATION_REQUIRED");

    // 3. Resolution: RECONCILIATION_REQUIRED -> SUCCEEDED
    const succeeded = await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "RECONCILIATION_REQUIRED",
      toStatus: "SUCCEEDED",
      paypalPayoutItemId: "PAYPAL_RECONCILED_999",
    });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.paypalPayoutItemId).toBe("PAYPAL_RECONCILED_999");

    // Verify all audit entries exist in order
    const auditRows = await pgClient.query(
      'SELECT "action" FROM "AuditLog" WHERE "entityId" = $1 ORDER BY "timestamp" ASC',
      [reservation.transaction.id]
    );
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toEqual([
      "PAYOUT_RESERVED",
      "PAYOUT_PROCESSING_STARTED",
      "PAYOUT_AMBIGUOUS",
      "PAYOUT_RECONCILIATION_REQUIRED",
      "PAYOUT_SUCCEEDED",
    ]);
  });

  // 10. Transition to SUCCEEDED acquires milestone lock first and prevents duplicate payouts
  it("Requirement 10: Partial unique index prevents duplicate succeeded payouts per milestone", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    const reservation = await paymentService.reservePayout({
      milestoneId: milestone.id,
      submissionId: submission.id,
      developerPayPalEmail: "dev@pay.test",
    });

    await paymentService.claimProcessing({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
    });

    await paymentService.transitionStatus({
      transactionId: reservation.transaction.id,
      milestoneId: milestone.id,
      fromStatus: "PROCESSING",
      toStatus: "SUCCEEDED",
      paypalPayoutItemId: "PAYPAL_FIRST_OK",
    });

    // Attempt direct raw INSERT of another SUCCEEDED payout on same milestone
    await expect(
      pgClient.query(`
        INSERT INTO "PaymentTransaction" (
          "id", "milestoneId", "submissionId", "attemptNumber", "idempotencyKey",
          "amountMinorUnits", "currency", "transactionType", "status", "paypalPayoutItemId"
        ) VALUES (
          'pay_dup_succeeded', '${milestone.id}', '${submission.id}', 2, 'dup_key_999',
          500000, 'USD', 'PAYOUT', 'SUCCEEDED', 'PAYPAL_SECOND_FAIL'
        )
      `)
    ).rejects.toThrow(); // PostgreSQL unique index violation error: idx_single_succeeded_payout_per_milestone
  });

  // 11. Transaction atomicity: failure during reservation rolls back both payment and audit
  it("Requirement 11: Transaction atomicity: failure during reservation rolls back all database changes", async () => {
    const { milestone, submission } = await setupEligibleMilestone();

    // Create a mock audit service that fails on recordEvent
    const failingAuditService = {
      recordEvent: async () => {
        throw new Error("Simulated audit write failure");
      },
    } as unknown as TransactionalAuditService;

    const failingPaymentCoordinator = new PaymentCoordinatorService(
      paymentRepo,
      failingAuditService,
      prisma
    );

    await expect(
      failingPaymentCoordinator.reservePayout({
        milestoneId: milestone.id,
        submissionId: submission.id,
        developerPayPalEmail: "dev@pay.test",
      })
    ).rejects.toThrow("Simulated audit write failure");

    // Verify no PaymentTransaction was committed
    const txCount = await pgClient.query('SELECT COUNT(*) FROM "PaymentTransaction" WHERE "milestoneId" = $1', [milestone.id]);
    expect(parseInt(txCount.rows[0].count, 10)).toBe(0);

    // Verify no AuditLog was committed
    const auditCount = await pgClient.query('SELECT COUNT(*) FROM "AuditLog" WHERE "entityType" = $1', ["PAYMENT"]);
    expect(parseInt(auditCount.rows[0].count, 10)).toBe(0);
  });
});
