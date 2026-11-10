/**
 * VeriRelease Append-Only Audit Logging & Immutability Integration Test Suite
 *
 * Verifies:
 * 1. Audit event successfully persisted.
 * 2. Policy evaluation start creates the expected system audit event.
 * 3. Successful policy evaluation creates its completion audit event.
 * 4. Failed policy evaluation creates the correct changes-requested event.
 * 5. Audit insertion failure rolls back the corresponding business state change.
 * 6. Business state transition failure leaves no audit record.
 * 7. Ordinary SQL UPDATE on audit records is rejected.
 * 8. Ordinary SQL DELETE on audit records is rejected.
 * 9. Runtime role cannot TRUNCATE audit records.
 * 10. Runtime role cannot bypass or disable audit immutability controls.
 * 11. Existing audit records remain readable by authorized application roles.
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
import { DomainValidationError, InvalidStateTransitionError } from "../../src/modules/common/errors";

describe("Append-Only Audit Logging & Immutability Integration Test Suite", () => {
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
    const clientId = "usr_client_audit_01";
    const devId = "usr_dev_audit_01";

    await pgClient.query(`
      INSERT INTO "User" (id, email, name, role)
      VALUES 
        ('${clientId}', 'client@audit.test', 'Client User', 'CLIENT'),
        ('${devId}', 'dev@audit.test', 'Dev User', 'DEVELOPER');
    `);

    return { clientId, devId };
  }

  async function setupSubmittedMilestone() {
    const { clientId, devId } = await seedUsers();

    const contract = await contractRepo.create({
      title: "Audit Test Contract",
      description: "Testing audit trail integration",
      clientId,
      developerId: devId,
      totalAmountMinorUnits: 1000000n,
      currency: "USD",
      githubRepoOwner: "acme",
      githubRepoName: "webapp",
    });

    const milestone = await milestoneRepo.create({
      contractId: contract.id,
      title: "Audit Test Milestone",
      description: "Milestone for audit verification",
      orderIndex: 1,
      amountMinorUnits: 500000n,
      currency: "USD",
      criteria: [
        {
          orderIndex: 1,
          title: "Unit Test Criterion",
          description: "All unit tests pass",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    await milestoneRepo.updateStatus(milestone.id, "FUNDED");

    const submission = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 101,
      prCommitSha: "1111111111111111111111111111111111111111",
      prUrl: "https://github.com/acme/webapp/pull/101",
      submittedById: devId,
    });

    return { clientId, devId, contract, milestone, submission };
  }

  // 1. Audit event successfully persisted
  it("Requirement 1: Audit event is successfully persisted to AuditLog table with typed actor and canonical hash", async () => {
    const { clientId } = await seedUsers();

    const result = await auditService.recordEvent({
      entityType: "CONTRACT",
      entityId: "cnt_audit_01",
      actorType: "USER",
      actorUserId: clientId,
      action: "CONTRACT_CREATED",
      metadata: { scope: "initial MVP" },
      correlationId: "corr_audit_001",
    });

    expect(result.auditLog).toBeDefined();
    expect(result.auditLog.id).toBeDefined();
    expect(result.eventHash).toMatch(/^[0-9a-f]{64}$/);

    // Verify row directly in PostgreSQL
    const dbRow = await pgClient.query('SELECT * FROM "AuditLog" WHERE id = $1', [result.auditLog.id]);
    expect(dbRow.rows.length).toBe(1);
    expect(dbRow.rows[0].entityType).toBe("CONTRACT");
    expect(dbRow.rows[0].actorType).toBe("USER");
    expect(dbRow.rows[0].actorUserId).toBe(clientId);
    expect(dbRow.rows[0].actorSystemPrincipal).toBeNull();
    expect(dbRow.rows[0].action).toBe("CONTRACT_CREATED");
    expect(dbRow.rows[0].metadata).toMatchObject({
      scope: "initial MVP",
      eventHash: result.eventHash,
    });
  });

  // 2. Policy evaluation start creates the expected system audit event
  it("Requirement 2: Policy evaluation start creates the expected system audit event with EVALUATION_STARTED", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { testCount: 10, passed: 10 },
      },
    ];

    await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    // Check audit events for the milestone
    const events = await auditRepo.findByEntity("MILESTONE", milestone.id);
    const startEvent = events.find((e) => e.action === "EVALUATION_STARTED");

    expect(startEvent).toBeDefined();
    expect(startEvent!.actorType).toBe("SYSTEM_PRINCIPAL");
    expect(startEvent!.actorSystemPrincipal).toBe("SYSTEM_POLICY_ENGINE");
    expect(startEvent!.actorUserId).toBeNull();
    expect(startEvent!.previousState).toMatchObject({ status: "SUBMITTED" });
    expect(startEvent!.newState).toMatchObject({ status: "EVALUATING" });
    expect(startEvent!.correlationId).toBe(submission.id);
  });

  // 3. Successful policy evaluation creates its completion audit event
  it("Requirement 3: Successful policy evaluation creates its completion audit event with POLICY_EVALUATION_APPROVED", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { testCount: 10, passed: 10 },
      },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    expect(result.evaluationResult.decision).toBe("PASS");

    // Check completion audit event
    const events = await auditRepo.findByEntity("MILESTONE", milestone.id);
    const approvedEvent = events.find((e) => e.action === "POLICY_EVALUATION_APPROVED");

    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.actorType).toBe("SYSTEM_PRINCIPAL");
    expect(approvedEvent!.actorSystemPrincipal).toBe("SYSTEM_POLICY_ENGINE");
    expect(approvedEvent!.actorUserId).toBeNull();
    expect(approvedEvent!.previousState).toMatchObject({ status: "EVALUATING" });
    expect(approvedEvent!.newState).toMatchObject({ status: "ELIGIBLE_FOR_PAYOUT" });
    expect(approvedEvent!.metadata).toMatchObject({
      decision: "PASS",
      evaluationId: result.evaluation.id,
      submissionId: submission.id,
    });
  });

  // 4. Failed policy evaluation creates the correct changes-requested event
  it("Requirement 4: Failed policy evaluation creates the correct changes-requested event with CHANGES_REQUESTED", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: false,
        evidence: { testCount: 10, passed: 8, failed: 2 },
      },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    expect(result.evaluationResult.decision).toBe("FAIL");

    // Check changes-requested audit event
    const events = await auditRepo.findByEntity("MILESTONE", milestone.id);
    const failEvent = events.find((e) => e.action === "CHANGES_REQUESTED");

    expect(failEvent).toBeDefined();
    expect(failEvent!.actorType).toBe("SYSTEM_PRINCIPAL");
    expect(failEvent!.actorSystemPrincipal).toBe("SYSTEM_POLICY_ENGINE");
    expect(failEvent!.actorUserId).toBeNull();
    expect(failEvent!.previousState).toMatchObject({ status: "EVALUATING" });
    expect(failEvent!.newState).toMatchObject({ status: "CHANGES_REQUESTED" });
    expect(failEvent!.metadata).toMatchObject({
      decision: "FAIL",
      evaluationId: result.evaluation.id,
      submissionId: submission.id,
    });
  });

  // 5. Audit insertion failure rolls back the corresponding business state change
  it("Requirement 5: Failure during audit insertion rolls back the business state change and leaves no partial state", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    // Create a mock audit service that throws an error on recordEvent
    const failingAuditService: typeof auditService = {
      ...auditService,
      recordEvent: async () => {
        throw new Error("Simulated transactional audit write failure");
      },
    } as unknown as TransactionalAuditService;

    const failingPolicyService = new PolicyEvaluationService(
      policyRepo,
      milestoneRepo,
      submissionRepo,
      failingAuditService,
      prisma
    );

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { testCount: 10, passed: 10 },
      },
    ];

    await expect(
      failingPolicyService.evaluateSubmission({
        submissionId: submission.id,
        assessments,
      })
    ).rejects.toThrow("Simulated transactional audit write failure");

    // Verify Milestone was NOT updated and remains SUBMITTED
    const milestoneInDb = await milestoneRepo.findById(milestone.id);
    expect(milestoneInDb!.status).toBe("SUBMITTED");

    // Verify no PolicyEvaluation record remains committed
    const evals = await policyRepo.findBySubmissionId(submission.id);
    expect(evals).toHaveLength(0);

    // Verify no AuditLog rows exist for this milestone
    const auditLogs = await auditRepo.findByEntity("MILESTONE", milestone.id);
    expect(auditLogs).toHaveLength(0);
  });

  // 6. Business state transition failure leaves no audit record
  it("Requirement 6: Business state transition failure leaves no audit record committed", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    // Transition milestone directly to CANCELLED in DB so transition to EVALUATING fails
    await pgClient.query(`UPDATE "Milestone" SET status = 'CANCELLED' WHERE id = '${milestone.id}';`);

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { testCount: 10, passed: 10 },
      },
    ];

    await expect(
      policyService.evaluateSubmission({
        submissionId: submission.id,
        assessments,
      })
    ).rejects.toThrow(InvalidStateTransitionError);

    // Verify no audit log was recorded for this aborted operation
    const auditLogs = await auditRepo.findByEntity("MILESTONE", milestone.id);
    expect(auditLogs).toHaveLength(0);
  });

  // 7. Ordinary SQL UPDATE on audit records is rejected
  it("Requirement 7: Ordinary SQL UPDATE on AuditLog is rejected with SQLSTATE 55000 by trigger", async () => {
    const { clientId } = await seedUsers();

    const result = await auditService.recordEvent({
      entityType: "CONTRACT",
      entityId: "cnt_immut_01",
      actorType: "USER",
      actorUserId: clientId,
      action: "CONTRACT_CREATED",
    });

    await expect(
      pgClient.query('UPDATE "AuditLog" SET action = \'TAMPERED\' WHERE id = $1;', [result.auditLog.id])
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("SECURITY VIOLATION: AuditLog entries are strictly append-only"),
    });

    // Verify row was not modified
    const verifyRow = await pgClient.query('SELECT action FROM "AuditLog" WHERE id = $1;', [result.auditLog.id]);
    expect(verifyRow.rows[0].action).toBe("CONTRACT_CREATED");
  });

  // 8. Ordinary SQL DELETE on audit records is rejected
  it("Requirement 8: Ordinary SQL DELETE on AuditLog is rejected with SQLSTATE 55000 by trigger", async () => {
    const { clientId } = await seedUsers();

    const result = await auditService.recordEvent({
      entityType: "CONTRACT",
      entityId: "cnt_immut_02",
      actorType: "USER",
      actorUserId: clientId,
      action: "CONTRACT_CREATED",
    });

    await expect(
      pgClient.query('DELETE FROM "AuditLog" WHERE id = $1;', [result.auditLog.id])
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("SECURITY VIOLATION: AuditLog entries are strictly append-only"),
    });

    // Verify row still exists
    const verifyRow = await pgClient.query('SELECT id FROM "AuditLog" WHERE id = $1;', [result.auditLog.id]);
    expect(verifyRow.rows.length).toBe(1);
  });

  // 9. Runtime role cannot TRUNCATE audit records
  it("Requirement 9: Runtime application role verirelease_app_user cannot TRUNCATE AuditLog (42501)", async () => {
    const appPool = new Pool({
      host: "/tmp",
      port: 5433,
      user: "verirelease_app_user",
      database: "verirelease_test",
    });
    const appClient = await appPool.connect();

    try {
      await expect(
        appClient.query('TRUNCATE TABLE "AuditLog";')
      ).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
      });
    } finally {
      appClient.release();
      await appPool.end();
    }
  });

  // 10. Runtime role cannot bypass or disable audit immutability controls
  it("Requirement 10: Runtime application role verirelease_app_user cannot disable triggers or alter AuditLog table (42501)", async () => {
    const appPool = new Pool({
      host: "/tmp",
      port: 5433,
      user: "verirelease_app_user",
      database: "verirelease_test",
    });
    const appClient = await appPool.connect();

    try {
      // Cannot disable trigger
      await expect(
        appClient.query('ALTER TABLE "AuditLog" DISABLE TRIGGER trg_audit_log_immutable;')
      ).rejects.toMatchObject({
        code: "42501",
      });

      // Cannot disable all triggers
      await expect(
        appClient.query('ALTER TABLE "AuditLog" DISABLE TRIGGER ALL;')
      ).rejects.toMatchObject({
        code: "42501",
      });

      // Cannot drop trigger
      await expect(
        appClient.query('DROP TRIGGER trg_audit_log_immutable ON "AuditLog";')
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      appClient.release();
      await appPool.end();
    }
  });

  // 11. Existing audit records remain readable by authorized application roles
  it("Requirement 11: Existing audit records remain readable and appendable by verirelease_app_user", async () => {
    const { clientId } = await seedUsers();

    // Insert an audit log as superuser
    const record = await auditService.recordEvent({
      entityType: "CONTRACT",
      entityId: "cnt_read_01",
      actorType: "USER",
      actorUserId: clientId,
      action: "CONTRACT_CREATED",
      correlationId: "corr_read_01",
    });

    const appPool = new Pool({
      host: "/tmp",
      port: 5433,
      user: "verirelease_app_user",
      database: "verirelease_test",
    });
    const appClient = await appPool.connect();

    try {
      // Readable via SELECT
      const selectRes = await appClient.query('SELECT * FROM "AuditLog" WHERE id = $1;', [record.auditLog.id]);
      expect(selectRes.rows.length).toBe(1);
      expect(selectRes.rows[0].action).toBe("CONTRACT_CREATED");

      // Appendable via INSERT
      const insertRes = await appClient.query(`
        INSERT INTO "AuditLog" (
          id, "entityType", "entityId", "actorType", "actorUserId", action, "correlationId"
        ) VALUES (
          'aud_app_user_ins_01', 'CONTRACT', 'cnt_read_01', 'USER', '${clientId}', 'CONTRACT_VIEWED', 'corr_app_01'
        ) RETURNING id;
      `);
      expect(insertRes.rows.length).toBe(1);
      expect(insertRes.rows[0].id).toBe("aud_app_user_ins_01");
    } finally {
      appClient.release();
      await appPool.end();
    }
  });
});
