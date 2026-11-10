import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { execSync } from "node:child_process";
import { MILESTONE_STATUSES } from "../../src/modules/contracts/types";

// Connection pool targeting local PostgreSQL test instance
const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("Database Constraints, Triggers, and Roles Integration Test Suite", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) client.release();
    await pool.end();
  });

  beforeEach(async () => {
    // Reset schema state cleanly between tests as superuser
    await client.query(`
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

  // Helper to create basic fixtures (client, dev, contract, milestones)
  async function seedBasicContract(contractTotal = 1000000n, m1Amount = 400000n, m2Amount = 400000n) {
    const clientId = "usr_client_001";
    const devId = "usr_dev_001";
    const contractId = "cnt_001";
    const m1Id = "mls_001";
    const m2Id = "mls_002";

    await client.query(`
      INSERT INTO "User" (id, email, name, role)
      VALUES 
        ('${clientId}', 'client@test.com', 'Test Client', 'CLIENT'),
        ('${devId}', 'dev@test.com', 'Test Dev', 'DEVELOPER');
    `);

    await client.query(`
      INSERT INTO "Contract" (id, title, description, "clientId", "developerId", "totalAmountMinorUnits", currency, "githubRepoOwner", "githubRepoName")
      VALUES 
        ('${contractId}', 'Test Contract', 'Desc', '${clientId}', '${devId}', ${contractTotal}, 'USD', 'acme', 'repo');
    `);

    await client.query(`
      INSERT INTO "Milestone" (id, "contractId", title, description, "orderIndex", "amountMinorUnits", currency, status)
      VALUES 
        ('${m1Id}', '${contractId}', 'Milestone 1', 'Desc 1', 1, ${m1Amount}, 'USD', 'FUNDED'),
        ('${m2Id}', '${contractId}', 'Milestone 2', 'Desc 2', 2, ${m2Amount}, 'USD', 'DRAFT');
    `);

    return { clientId, devId, contractId, m1Id, m2Id };
  }

  // 1. Prisma schema validation
  it("Requirement 1: Prisma schema validates cleanly", () => {
    const output = execSync(
      'DATABASE_URL="postgresql://postgres@localhost:5433/verirelease_test" npx prisma validate',
      { encoding: "utf8" }
    );
    expect(output).toContain("is valid");
  });

  // 2. Migration verification
  it("Requirement 2: Initial migration tables, enums, and functions exist", async () => {
    const res = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `);
    const tables = res.rows.map((r: { tablename: string }) => r.tablename);
    expect(tables).toContain("User");
    expect(tables).toContain("Contract");
    expect(tables).toContain("Milestone");
    expect(tables).toContain("AcceptanceCriterion");
    expect(tables).toContain("MilestoneSubmission");
    expect(tables).toContain("PolicyEvaluation");
    expect(tables).toContain("PaymentTransaction");
    expect(tables).toContain("AuditLog");
  });

  it("Requirement 2b: Database MilestoneStatus enum exactly matches Slice 2.1 domain MILESTONE_STATUSES", async () => {
    const enumRes = await client.query(`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE typname = 'MilestoneStatus'
      ORDER BY enumsortorder;
    `);
    const dbLabels = enumRes.rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(dbLabels).toEqual([...MILESTONE_STATUSES]);
  });

  // 3. Composite foreign key cross-milestone prevention
  it("Requirement 3: Composite FK prevents a payment from referencing a submission belonging to a different milestone", async () => {
    const { devId, m1Id, m2Id } = await seedBasicContract();

    // Create Submission S1 belonging to Milestone 1
    const sub1Id = "sub_001";
    const hexSha = "a".repeat(40);
    const hexHash = "b".repeat(64);
    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${sub1Id}', '${m1Id}', 1, 101, '${hexSha}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${hexHash}', '${devId}'
      );
    `);

    // Attempting to insert a payout for Milestone 2 that references Submission S1 (which belongs to Milestone 1)
    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_cross_mls_001', '${m2Id}', '${sub1Id}', 'PAYOUT', 'RESERVED', 'idem_cross_001',
          400000, 'USD', 1
        );
      `)
    ).rejects.toMatchObject({
      code: "23503", // foreign_key_violation
      constraint: "fk_payment_submission_milestone_scoped",
    });

    // Valid: Payment for Milestone 1 referencing Submission S1 (belongs to Milestone 1) succeeds
    const validResult = await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
        "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_valid_mls_001', '${m1Id}', '${sub1Id}', 'PAYOUT', 'RESERVED', 'idem_valid_001',
        400000, 'USD', 1
      ) RETURNING id;
    `);
    expect(validResult.rows.length).toBe(1);
  });

  // 4. PAYOUT requires non-null submissionId
  it("Requirement 4: Payment with type 'PAYOUT' cannot be inserted with null submissionId", async () => {
    const { m1Id } = await seedBasicContract();

    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_payout_null_sub', '${m1Id}', NULL, 'PAYOUT', 'RESERVED', 'idem_payout_null_sub',
          400000, 'USD', 1
        );
      `)
    ).rejects.toMatchObject({
      code: "23514", // check_violation
      constraint: "chk_payment_payout_requires_submission",
    });
  });

  // 5. FUNDING_AUTHORIZATION and REFUND allow null submissionId (and reject non-null submissionId)
  it("Requirement 5: FUNDING_AUTHORIZATION and REFUND can be inserted with null submissionId, but reject non-null submissionId", async () => {
    const { devId, m1Id } = await seedBasicContract();

    // FUNDING_AUTHORIZATION with null submissionId succeeds
    const fundingRes = await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
        "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_funding_001', '${m1Id}', NULL, 'FUNDING_AUTHORIZATION', 'CREATED', 'idem_funding_001',
        400000, 'USD', 1
      ) RETURNING id;
    `);
    expect(fundingRes.rows.length).toBe(1);

    // REFUND with null submissionId succeeds
    const refundRes = await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
        "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_refund_001', '${m1Id}', NULL, 'REFUND', 'CREATED', 'idem_refund_001',
        400000, 'USD', 1
      ) RETURNING id;
    `);
    expect(refundRes.rows.length).toBe(1);

    // Create a submission to test invalid non-null submission on FUNDING_AUTHORIZATION
    const sub1Id = "sub_001";
    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${sub1Id}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${"b".repeat(64)}', '${devId}'
      );
    `);

    // Non-null submission on FUNDING_AUTHORIZATION must be rejected
    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_funding_invalid_sub', '${m1Id}', '${sub1Id}', 'FUNDING_AUTHORIZATION', 'CREATED', 'idem_funding_bad',
          400000, 'USD', 2
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_payment_payout_requires_submission",
    });
  });

  // 6. Single SUCCEEDED payout uniqueness per milestone
  it("Requirement 6: Attempting to insert a second SUCCEEDED payout for the same milestone violates idx_single_succeeded_payout_per_milestone", async () => {
    const { devId, m1Id } = await seedBasicContract();
    const sub1Id = "sub_001";
    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${sub1Id}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${"b".repeat(64)}', '${devId}'
      );
    `);

    // First SUCCEEDED payout
    await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
        "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_payout_succeeded_1', '${m1Id}', '${sub1Id}', 'PAYOUT', 'SUCCEEDED', 'idem_payout_succ_1',
        400000, 'USD', 1
      );
    `);

    // Second SUCCEEDED payout on same milestone violates partial unique index
    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_payout_succeeded_2', '${m1Id}', '${sub1Id}', 'PAYOUT', 'SUCCEEDED', 'idem_payout_succ_2',
          400000, 'USD', 2
        );
      `)
    ).rejects.toMatchObject({
      code: "23505", // unique_violation
      constraint: "idx_single_succeeded_payout_per_milestone",
    });
  });

  // 7. AuditLog UPDATE raises SQLSTATE 55000
  it("Requirement 7: Attempting to UPDATE an AuditLog row raises SQLSTATE 55000 from the trigger", async () => {
    const { clientId } = await seedBasicContract();

    await client.query(`
      INSERT INTO "AuditLog" (
        id, "entityType", "entityId", "actorType", "actorUserId", action, "correlationId"
      ) VALUES (
        'aud_001', 'CONTRACT', 'cnt_001', 'USER', '${clientId}', 'CONTRACT_CREATED', 'corr_001'
      );
    `);

    await expect(
      client.query(`
        UPDATE "AuditLog" SET action = 'TAMPERED' WHERE id = 'aud_001';
      `)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("SECURITY VIOLATION: AuditLog entries are strictly append-only"),
    });
  });

  // 8. AuditLog DELETE raises SQLSTATE 55000
  it("Requirement 8: Attempting to DELETE an AuditLog row raises SQLSTATE 55000 from the trigger", async () => {
    const { clientId } = await seedBasicContract();

    await client.query(`
      INSERT INTO "AuditLog" (
        id, "entityType", "entityId", "actorType", "actorUserId", action, "correlationId"
      ) VALUES (
        'aud_002', 'CONTRACT', 'cnt_001', 'USER', '${clientId}', 'CONTRACT_CREATED', 'corr_002'
      );
    `);

    await expect(
      client.query(`
        DELETE FROM "AuditLog" WHERE id = 'aud_002';
      `)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("SECURITY VIOLATION: AuditLog entries are strictly append-only"),
    });
  });

  // 9. AuditLog USER actor with null actorUserId violates check constraint
  it("Requirement 9: Attempting to insert an AuditLog row with actorType 'USER' and null actorUserId violates chk_audit_actor_consistency", async () => {
    const { clientId } = await seedBasicContract();

    // actorType = 'USER' but actorUserId is null
    await expect(
      client.query(`
        INSERT INTO "AuditLog" (
          id, "entityType", "entityId", "actorType", "actorUserId", "actorSystemPrincipal", action, "correlationId"
        ) VALUES (
          'aud_bad_user_1', 'CONTRACT', 'cnt_001', 'USER', NULL, NULL, 'ACTION', 'corr_bad_1'
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_audit_actor_consistency",
    });

    // actorType = 'USER' with both actorUserId AND actorSystemPrincipal populated (violates mutual exclusivity)
    await expect(
      client.query(`
        INSERT INTO "AuditLog" (
          id, "entityType", "entityId", "actorType", "actorUserId", "actorSystemPrincipal", action, "correlationId"
        ) VALUES (
          'aud_bad_user_2', 'CONTRACT', 'cnt_001', 'USER', '${clientId}', 'principal_001', 'ACTION', 'corr_bad_2'
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_audit_actor_consistency",
    });
  });

  // 10. AuditLog non-USER actor with non-null actorUserId violates check constraint
  it("Requirement 10: Attempting to insert an AuditLog row with actorType 'SYSTEM_PRINCIPAL' and non-null actorUserId violates chk_audit_actor_consistency", async () => {
    const { clientId } = await seedBasicContract();

    // Non-USER actor with actorUserId populated
    await expect(
      client.query(`
        INSERT INTO "AuditLog" (
          id, "entityType", "entityId", "actorType", "actorUserId", "actorSystemPrincipal", action, "correlationId"
        ) VALUES (
          'aud_bad_sys_1', 'CONTRACT', 'cnt_001', 'SYSTEM_PRINCIPAL', '${clientId}', 'worker_001', 'ACTION', 'corr_bad_sys_1'
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_audit_actor_consistency",
    });

    // Non-USER actor with null actorSystemPrincipal
    await expect(
      client.query(`
        INSERT INTO "AuditLog" (
          id, "entityType", "entityId", "actorType", "actorUserId", "actorSystemPrincipal", action, "correlationId"
        ) VALUES (
          'aud_bad_sys_2', 'CONTRACT', 'cnt_001', 'SYSTEM_PRINCIPAL', NULL, NULL, 'ACTION', 'corr_bad_sys_2'
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_audit_actor_consistency",
    });

    // Valid Non-USER actor insertion succeeds
    const validSys = await client.query(`
      INSERT INTO "AuditLog" (
        id, "entityType", "entityId", "actorType", "actorUserId", "actorSystemPrincipal", action, "correlationId"
      ) VALUES (
        'aud_valid_sys', 'CONTRACT', 'cnt_001', 'SYSTEM_PRINCIPAL', NULL, 'payout-worker', 'PAYOUT_DISPATCHED', 'corr_sys_ok'
      ) RETURNING id;
    `);
    expect(validSys.rows.length).toBe(1);
  });

  // 10b. PaymentReconciliation immutability trigger raises 55000 and check constraints are enforced
  it("Requirement 10b: PaymentReconciliation immutability trigger raises 55000 and check constraints are enforced", async () => {
    const { clientId, m1Id } = await seedBasicContract();

    // Create payment transaction
    await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "transactionType", status, "idempotencyKey", "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_rec_test_001', '${m1Id}', 'FUNDING_AUTHORIZATION', 'PAYOUT_UNCERTAIN', 'key_rec_001', 400000, 'USD', 1
      );
    `);

    // Insert valid reconciliation
    await client.query(`
      INSERT INTO "PaymentReconciliation" (
        id, "paymentTransactionId", decision, reason, "evidenceReference", "evidenceType", "actorType", "actorUserId"
      ) VALUES (
        'rec_001', 'tx_rec_test_001', 'CONFIRMED_SUCCEEDED', 'Confirmed by support', 'paypal-ticket-123', 'SUPPORT_TICKET', 'USER', '${clientId}'
      );
    `);

    // UPDATE fails with SQLSTATE 55000
    await expect(
      client.query(`UPDATE "PaymentReconciliation" SET reason = 'tampered' WHERE id = 'rec_001';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("PaymentReconciliation entries are strictly append-only"),
    });

    // DELETE fails with SQLSTATE 55000
    await expect(
      client.query(`DELETE FROM "PaymentReconciliation" WHERE id = 'rec_001';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("PaymentReconciliation entries are strictly append-only"),
    });

    // Empty reason violates chk_reconciliation_reason
    await expect(
      client.query(`
        INSERT INTO "PaymentReconciliation" (
          id, "paymentTransactionId", decision, reason, "evidenceReference", "actorType", "actorUserId"
        ) VALUES (
          'rec_bad_1', 'tx_rec_test_001', 'CONFIRMED_SUCCEEDED', '   ', 'ref-1', 'USER', '${clientId}'
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_reconciliation_reason",
    });

    // Missing evidenceReference on CONFIRMED_SUCCEEDED violates chk_reconciliation_evidence
    await expect(
      client.query(`
        INSERT INTO "PaymentReconciliation" (
          id, "paymentTransactionId", decision, reason, "evidenceReference", "actorType", "actorUserId"
        ) VALUES (
          'rec_bad_2', 'tx_rec_test_001', 'CONFIRMED_SUCCEEDED', 'Some reason', NULL, 'USER', '${clientId}'
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_reconciliation_evidence",
    });

    // Missing evidenceReference on STILL_UNCERTAIN is permitted
    const stillUncertain = await client.query(`
      INSERT INTO "PaymentReconciliation" (
        id, "paymentTransactionId", decision, reason, "evidenceReference", "actorType", "actorUserId"
      ) VALUES (
        'rec_ok_uncert', 'tx_rec_test_001', 'STILL_UNCERTAIN', 'Still waiting for provider', NULL, 'USER', '${clientId}'
      ) RETURNING id;
    `);
    expect(stillUncertain.rows.length).toBe(1);

    // Actor consistency: USER without actorUserId violates chk_reconciliation_actor
    await expect(
      client.query(`
        INSERT INTO "PaymentReconciliation" (
          id, "paymentTransactionId", decision, reason, "evidenceReference", "actorType", "actorUserId"
        ) VALUES (
          'rec_bad_3', 'tx_rec_test_001', 'STILL_UNCERTAIN', 'Reason', NULL, 'USER', NULL
        );
      `)
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_reconciliation_actor",
    });
  });

  // 11. Acceptance criteria and submissions cannot be updated or deleted after creation
  it("Requirement 11: Acceptance criteria and submissions cannot be updated or deleted after creation", async () => {
    const { devId, m1Id } = await seedBasicContract();

    // Create Criterion
    const critId = "crit_001";
    await client.query(`
      INSERT INTO "AcceptanceCriterion" (
        id, "milestoneId", version, "orderIndex", title, description, "criterionType"
      ) VALUES (
        '${critId}', '${m1Id}', 1, 1, 'Criterion 1', 'Description 1', 'AUTOMATED_TEST'
      );
    `);

    // Criterion UPDATE rejected with SQLSTATE 55000
    await expect(
      client.query(`UPDATE "AcceptanceCriterion" SET title = 'New Title' WHERE id = '${critId}';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("AcceptanceCriterion records are strictly immutable"),
    });

    // Criterion DELETE rejected with SQLSTATE 55000
    await expect(
      client.query(`DELETE FROM "AcceptanceCriterion" WHERE id = '${critId}';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("AcceptanceCriterion records are strictly immutable"),
    });

    // Create Submission
    const subId = "sub_immut_001";
    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${subId}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${"b".repeat(64)}', '${devId}'
      );
    `);

    // Submission UPDATE rejected with SQLSTATE 55000
    await expect(
      client.query(`UPDATE "MilestoneSubmission" SET status = 'SUPERSEDED' WHERE id = '${subId}';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("MilestoneSubmission records are strictly immutable"),
    });

    // Submission DELETE rejected with SQLSTATE 55000
    await expect(
      client.query(`DELETE FROM "MilestoneSubmission" WHERE id = '${subId}';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("MilestoneSubmission records are strictly immutable"),
    });
  });

  // 12. Single active payment per milestone constraint (including RECONCILIATION_REQUIRED)
  it("Requirement 12: Single active payment per milestone rejects concurrent active payments including RECONCILIATION_REQUIRED", async () => {
    const { devId, m1Id } = await seedBasicContract();
    const sub1Id = "sub_001";
    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${sub1Id}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${"b".repeat(64)}', '${devId}'
      );
    `);

    // Active payment 1: RESERVED
    await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
        "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_act_1', '${m1Id}', '${sub1Id}', 'PAYOUT', 'RESERVED', 'idem_act_1',
        400000, 'USD', 1
      );
    `);

    // Concurrent active payment with status PROCESSING violates idx_single_active_payment_per_milestone
    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_act_2', '${m1Id}', '${sub1Id}', 'PAYOUT', 'PROCESSING', 'idem_act_2',
          400000, 'USD', 2
        );
      `)
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "idx_single_active_payment_per_milestone",
    });

    // Concurrent active payment with status PAYOUT_UNCERTAIN violates idx_single_active_payment_per_milestone
    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_act_3', '${m1Id}', '${sub1Id}', 'PAYOUT', 'PAYOUT_UNCERTAIN', 'idem_act_3',
          400000, 'USD', 3
        );
      `)
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "idx_single_active_payment_per_milestone",
    });

    // Concurrent active payment with status RECONCILIATION_REQUIRED violates idx_single_active_payment_per_milestone
    await expect(
      client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_act_4', '${m1Id}', '${sub1Id}', 'PAYOUT', 'RECONCILIATION_REQUIRED', 'idem_act_4',
          400000, 'USD', 4
        );
      `)
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "idx_single_active_payment_per_milestone",
    });

    // Transition payment 1 to terminal FAILED state
    await client.query(`
      UPDATE "PaymentTransaction" SET status = 'FAILED' WHERE id = 'tx_act_1';
    `);

    // Now inserting another payment (e.g. RESERVED) succeeds since there are 0 active payments in flight
    const retryRes = await client.query(`
      INSERT INTO "PaymentTransaction" (
        id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
        "amountMinorUnits", currency, "attemptNumber"
      ) VALUES (
        'tx_act_retry', '${m1Id}', '${sub1Id}', 'PAYOUT', 'RESERVED', 'idem_act_retry',
        400000, 'USD', 2
      ) RETURNING id;
    `);
    expect(retryRes.rows.length).toBe(1);
  });

  // 13. Role permission verification: verirelease_app_user cannot perform DDL or delete AuditLog
  it("Requirement 13: Role verification - verirelease_app_user cannot perform DDL or delete from AuditLog", async () => {
    const { clientId } = await seedBasicContract();

    // Populate an AuditLog row as superuser
    await client.query(`
      INSERT INTO "AuditLog" (
        id, "entityType", "entityId", "actorType", "actorUserId", action, "correlationId"
      ) VALUES (
        'aud_role_test', 'CONTRACT', 'cnt_001', 'USER', '${clientId}', 'CONTRACT_CREATED', 'corr_role_test'
      );
    `);

    // Switch to application runtime role
    await client.query("SET ROLE verirelease_app_user;");

    try {
      // 1. DDL attempt: CREATE TABLE must fail with permission denied (42501)
      await expect(
        client.query("CREATE TABLE public.tamper_table (id INT);")
      ).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
      });

      // 2. DDL attempt: ALTER TABLE must fail with permission denied (42501)
      await expect(
        client.query('ALTER TABLE "Milestone" DROP COLUMN "title";')
      ).rejects.toMatchObject({
        code: "42501",
      });

      // 3. DML attempt: DELETE FROM AuditLog must fail with permission denied (42501)
      await expect(
        client.query('DELETE FROM "AuditLog" WHERE id = \'aud_role_test\';')
      ).rejects.toMatchObject({
        code: "42501",
      });

      // 4. DML attempt: UPDATE AuditLog must fail with permission denied (42501)
      await expect(
        client.query('UPDATE "AuditLog" SET action = \'tampered\' WHERE id = \'aud_role_test\';')
      ).rejects.toMatchObject({
        code: "42501",
      });

      // 5. Normal permitted DML: SELECT and INSERT on AuditLog must succeed
      const selectRes = await client.query('SELECT COUNT(*) FROM "AuditLog";');
      expect(parseInt(selectRes.rows[0].count, 10)).toBe(1);

      const insertRes = await client.query(`
        INSERT INTO "AuditLog" (
          id, "entityType", "entityId", "actorType", "actorUserId", action, "correlationId"
        ) VALUES (
          'aud_role_app_insert', 'CONTRACT', 'cnt_001', 'USER', '${clientId}', 'ACTION_BY_APP', 'corr_app_insert'
        ) RETURNING id;
      `);
      expect(insertRes.rows.length).toBe(1);
    } finally {
      // Reset role back to postgres
      await client.query("RESET ROLE;");
    }
  });

  // Additional Invariant Tests: Allocation & Immutability Triggers
  it("Milestone Allocation Trigger: Rejects milestone insertions that exceed Contract totalAmountMinorUnits", async () => {
    const { contractId } = await seedBasicContract(500000n, 200000n, 200000n); // Total 500,000; M1=200k, M2=200k

    // Existing milestones sum to 400,000. Adding Milestone 3 with 200,000 exceeds 500,000!
    await expect(
      client.query(`
        INSERT INTO "Milestone" (id, "contractId", title, description, "orderIndex", "amountMinorUnits", currency, status)
        VALUES ('mls_overalloc', '${contractId}', 'Milestone Over', 'Desc', 3, 200000, 'USD', 'DRAFT');
      `)
    ).rejects.toMatchObject({
      code: "23514", // check_violation
      message: expect.stringContaining("Total milestone allocations"),
    });
  });

  it("Contract Total Reduction Trigger: Rejects reducing totalAmountMinorUnits below existing milestone allocations", async () => {
    const { contractId } = await seedBasicContract(1000000n); // M1 = 400,000, M2 = 400,000 (total allocated = 800,000)

    // Attempting to reduce Contract total to 700,000 (below 800,000) must fail
    await expect(
      client.query(`
        UPDATE "Contract" SET "totalAmountMinorUnits" = 700000 WHERE id = '${contractId}';
      `)
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Contract total (700000) cannot be reduced below existing milestone allocations (800000)"),
    });

    // Reducing to exactly 800,000 succeeds
    const okRes = await client.query(`
      UPDATE "Contract" SET "totalAmountMinorUnits" = 800000 WHERE id = '${contractId}' RETURNING "totalAmountMinorUnits";
    `);
    expect(okRes.rows[0].totalAmountMinorUnits).toBe("800000");
  });

  it("Policy Evaluation Immutability Trigger: Completed evaluations cannot be modified, and evaluations cannot be deleted", async () => {
    const { devId, m1Id } = await seedBasicContract();
    const sub1Id = "sub_eval_001";
    const hexHash = "c".repeat(64);

    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${sub1Id}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${hexHash}', '${devId}'
      );
    `);

    // In-progress evaluation can be updated to completed
    const evalId = "eval_001";
    await client.query(`
      INSERT INTO "PolicyEvaluation" (
        id, "submissionId", "milestoneId", "criteriaHash", "evaluationNumber", status
      ) VALUES (
        '${evalId}', '${sub1Id}', '${m1Id}', '${hexHash}', 1, 'IN_PROGRESS'
      );
    `);

    // An IN_PROGRESS evaluation cannot be deleted
    await expect(
      client.query(`DELETE FROM "PolicyEvaluation" WHERE id = '${evalId}';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("PolicyEvaluation records cannot be deleted"),
    });

    // Updating to COMPLETED
    await client.query(`
      UPDATE "PolicyEvaluation" 
      SET status = 'COMPLETED', decision = 'PASS', "decisionReason" = 'All criteria passed', 
          evaluations = '[]'::jsonb, "completedAt" = NOW()
      WHERE id = '${evalId}';
    `);

    // Attempting to modify completed evaluation raises SQLSTATE 55000
    await expect(
      client.query(`
        UPDATE "PolicyEvaluation" SET "decisionReason" = 'tampered' WHERE id = '${evalId}';
      `)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("Completed PolicyEvaluation records are strictly immutable"),
    });

    // Attempting to delete completed evaluation also raises SQLSTATE 55000
    await expect(
      client.query(`DELETE FROM "PolicyEvaluation" WHERE id = '${evalId}';`)
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining("Completed PolicyEvaluation records are strictly immutable"),
    });
  });

  it("Requirement: PolicyEvaluation lifecycle and permissions under actual verirelease_app_user role", async () => {
    const { devId, m1Id } = await seedBasicContract();
    const sub1Id = "sub_app_eval_001";
    const hexHash = "d".repeat(64);

    await client.query(`
      INSERT INTO "MilestoneSubmission" (
        id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
        "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
      ) VALUES (
        '${sub1Id}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
        1, '[]'::jsonb, '${hexHash}', '${devId}'
      );
    `);

    // Connect using actual application runtime role pool (not owner or deployer)
    const appPool = new Pool({
      host: process.env.PGHOST || "/tmp",
      port: parseInt(process.env.PGPORT || "5433", 10),
      user: "verirelease_app_user",
      database: process.env.PGDATABASE || "verirelease_test",
    });
    const appClient = await appPool.connect();

    try {
      // 0. Record actual connection identity
      const roleIdRes = await appClient.query("SELECT session_user, current_user, current_role;");
      expect(roleIdRes.rows[0].session_user).toBe("verirelease_app_user");
      expect(roleIdRes.rows[0].current_user).toBe("verirelease_app_user");
      expect(roleIdRes.rows[0].current_role).toBe("verirelease_app_user");

      // Query effective privileges using PostgreSQL privilege functions
      const privRes = await appClient.query(`
        SELECT
          has_table_privilege('verirelease_app_user', '"PolicyEvaluation"', 'SELECT') AS can_select,
          has_table_privilege('verirelease_app_user', '"PolicyEvaluation"', 'INSERT') AS can_insert,
          has_table_privilege('verirelease_app_user', '"PolicyEvaluation"', 'UPDATE') AS can_update,
          has_table_privilege('verirelease_app_user', '"PolicyEvaluation"', 'DELETE') AS can_delete,
          has_table_privilege('verirelease_app_user', '"PolicyEvaluation"', 'TRUNCATE') AS can_truncate;
      `);
      expect(privRes.rows[0].can_select).toBe(true);
      expect(privRes.rows[0].can_insert).toBe(true);
      expect(privRes.rows[0].can_update).toBe(true);
      expect(privRes.rows[0].can_delete).toBe(false);
      expect(privRes.rows[0].can_truncate).toBe(false);

      const evalId = "eval_app_user_001";

      // 1. Runtime role CAN insert an IN_PROGRESS evaluation
      const insRes = await appClient.query(`
        INSERT INTO "PolicyEvaluation" (
          id, "submissionId", "milestoneId", "criteriaHash", "evaluationNumber", status
        ) VALUES (
          '${evalId}', '${sub1Id}', '${m1Id}', '${hexHash}', 1, 'IN_PROGRESS'
        ) RETURNING id;
      `);
      expect(insRes.rows.length).toBe(1);

      // 2. Runtime role CAN update an IN_PROGRESS evaluation (e.g. updating policy version or metadata)
      const updRes = await appClient.query(`
        UPDATE "PolicyEvaluation"
        SET "policyVersion" = '1.0.1'
        WHERE id = '${evalId}'
        RETURNING "policyVersion";
      `);
      expect(updRes.rows[0].policyVersion).toBe("1.0.1");

      // 3. Runtime role CAN transition an evaluation to COMPLETED when all required fields are valid
      const compRes = await appClient.query(`
        UPDATE "PolicyEvaluation"
        SET status = 'COMPLETED', decision = 'PASS', "decisionReason" = 'All criteria passed',
            evaluations = '[]'::jsonb, "completedAt" = NOW()
        WHERE id = '${evalId}'
        RETURNING status, decision;
      `);
      expect(compRes.rows[0].status).toBe("COMPLETED");
      expect(compRes.rows[0].decision).toBe("PASS");

      // 4. Runtime role CANNOT update a COMPLETED evaluation (immutability trigger raises 55000)
      await expect(
        appClient.query(`
          UPDATE "PolicyEvaluation" SET "decisionReason" = 'tampered' WHERE id = '${evalId}';
        `)
      ).rejects.toMatchObject({
        code: "55000",
        message: expect.stringContaining("Completed PolicyEvaluation records are strictly immutable"),
      });

      // 5. Runtime role CANNOT delete any evaluation (missing DELETE privilege 42501)
      await expect(
        appClient.query(`DELETE FROM "PolicyEvaluation" WHERE id = '${evalId}';`)
      ).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
      });

      // 6. Runtime role CANNOT execute TRUNCATE on the table (missing TRUNCATE privilege 42501)
      await expect(
        appClient.query('TRUNCATE TABLE "PolicyEvaluation";')
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      appClient.release();
      await appPool.end();
    }
  });

  // --------------------------------------------------------------------------
  // Payment Currency Consistency Tests
  // --------------------------------------------------------------------------
  describe("Payment Currency Consistency", () => {
    it("Enforces at database level that PaymentTransaction currency must match Milestone currency", async () => {
      const { devId, m1Id } = await seedBasicContract(); // m1 is USD
      const sub1Id = "sub_curr_001";
      await client.query(`
        INSERT INTO "MilestoneSubmission" (
          id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
          "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
        ) VALUES (
          '${sub1Id}', '${m1Id}', 1, 101, '${"a".repeat(40)}', 'https://github.com/acme/repo/pull/101',
          1, '[]'::jsonb, '${"b".repeat(64)}', '${devId}'
        );
      `);

      // 1. Payment with milestone's currency (USD) succeeds
      const validPayout = await client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_curr_usd_ok', '${m1Id}', '${sub1Id}', 'PAYOUT', 'RESERVED', 'idem_curr_usd_ok',
          400000, 'USD', 1
        ) RETURNING id;
      `);
      expect(validPayout.rows.length).toBe(1);

      // Clean up for subsequent tests on same milestone
      await client.query('DELETE FROM "PaymentTransaction" WHERE id = \'tx_curr_usd_ok\';');

      // 2. Payment with mismatched currency (EUR for USD milestone) is rejected by composite FK fk_payment_milestone_currency
      await expect(
        client.query(`
          INSERT INTO "PaymentTransaction" (
            id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
            "amountMinorUnits", currency, "attemptNumber"
          ) VALUES (
            'tx_curr_eur_fail', '${m1Id}', '${sub1Id}', 'PAYOUT', 'RESERVED', 'idem_curr_eur_fail',
            400000, 'EUR', 1
          );
        `)
      ).rejects.toMatchObject({
        code: "23503", // foreign_key_violation
        constraint: "fk_payment_milestone_currency",
      });

      // 3. FUNDING_AUTHORIZATION with matching currency (USD) and NULL submissionId succeeds
      const validFunding = await client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_curr_fund_ok', '${m1Id}', NULL, 'FUNDING_AUTHORIZATION', 'CREATED', 'idem_curr_fund_ok',
          400000, 'USD', 1
        ) RETURNING id;
      `);
      expect(validFunding.rows.length).toBe(1);

      // FUNDING_AUTHORIZATION with mismatched currency (EUR) is rejected
      await expect(
        client.query(`
          INSERT INTO "PaymentTransaction" (
            id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
            "amountMinorUnits", currency, "attemptNumber"
          ) VALUES (
            'tx_curr_fund_bad', '${m1Id}', NULL, 'FUNDING_AUTHORIZATION', 'CREATED', 'idem_curr_fund_bad',
            400000, 'EUR', 2
          );
        `)
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_payment_milestone_currency",
      });

      // 4. REFUND with matching currency (USD) and NULL submissionId succeeds
      const validRefund = await client.query(`
        INSERT INTO "PaymentTransaction" (
          id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
          "amountMinorUnits", currency, "attemptNumber"
        ) VALUES (
          'tx_curr_ref_ok', '${m1Id}', NULL, 'REFUND', 'CREATED', 'idem_curr_ref_ok',
          400000, 'USD', 2
        ) RETURNING id;
      `);
      expect(validRefund.rows.length).toBe(1);

      // REFUND with mismatched currency (EUR) is rejected
      await expect(
        client.query(`
          INSERT INTO "PaymentTransaction" (
            id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
            "amountMinorUnits", currency, "attemptNumber"
          ) VALUES (
            'tx_curr_ref_bad', '${m1Id}', NULL, 'REFUND', 'CREATED', 'idem_curr_ref_bad',
            400000, 'EUR', 3
          );
        `)
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_payment_milestone_currency",
      });

      // 5. PAYOUT still requires submissionId belonging to the same milestone
      await expect(
        client.query(`
          INSERT INTO "PaymentTransaction" (
            id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
            "amountMinorUnits", currency, "attemptNumber"
          ) VALUES (
            'tx_payout_no_sub', '${m1Id}', NULL, 'PAYOUT', 'RESERVED', 'idem_payout_no_sub',
            400000, 'USD', 3
          );
        `)
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_payment_payout_requires_submission",
      });
    });
  });

  // --------------------------------------------------------------------------
  // End-to-End Fresh Disposable Database Deployment Verification
  // --------------------------------------------------------------------------
  describe("End-to-End Fresh Disposable Database Deployment Verification", () => {
    const dispDb = "verirelease_fresh_deploy_test";
    const pgHost = process.env.PGHOST || "/tmp";
    const pgPort = parseInt(process.env.PGPORT || "5433", 10);

    it("Executes complete deployment on fresh database and verifies ownership, privileges, and constraints", async () => {
      const rootClient = await pool.connect();
      try {
        // 1. Setup fresh disposable database
        await rootClient.query(`DROP DATABASE IF EXISTS ${dispDb};`);
        await rootClient.query(`CREATE DATABASE ${dispDb};`);

        const dispPool = new Pool({
          host: pgHost,
          port: pgPort,
          user: "postgres",
          database: dispDb,
        });
        const dispAdminClient = await dispPool.connect();

        try {
          // 2. Provision roles on fresh database
          const fs = await import("node:fs");
          const path = await import("node:path");
          const rolesSql = fs.readFileSync(
            path.resolve(process.cwd(), "scripts/provision-database-roles.sql"),
            "utf8"
          );
          await dispAdminClient.query(rolesSql);

          // 3. Connect as verirelease_deployer and execute migration workflow
          const deployerPool = new Pool({
            host: pgHost,
            port: pgPort,
            user: "verirelease_deployer",
            database: dispDb,
          });
          const deployerClient = await deployerPool.connect();

          try {
            // Verify session role switching: session_user is verirelease_deployer, current_user is verirelease_owner_role
            const roleCheck = await deployerClient.query("SELECT session_user, current_user, current_role;");
            expect(roleCheck.rows[0].session_user).toBe("verirelease_deployer");
            expect(roleCheck.rows[0].current_user).toBe("verirelease_owner_role");
            expect(roleCheck.rows[0].current_role).toBe("verirelease_owner_role");
          } finally {
            deployerClient.release();
            await deployerPool.end();
          }

          // Deploy migration using Prisma CLI workflow connected as verirelease_deployer
          const { execSync } = await import("node:child_process");
          const migrationDbUrl = `postgresql://verirelease_deployer@localhost:${pgPort}/${dispDb}?host=${pgHost}`;
          const prismaBin = path.resolve(process.cwd(), "node_modules/.bin/prisma");
          execSync(`"${prismaBin}" migrate deploy`, {
            env: {
              ...process.env,
              DATABASE_URL: migrationDbUrl,
            },
            encoding: "utf8",
            stdio: "pipe",
          });

          // Verify identity captured directly within the actual Prisma migration execution context
          // Note: Column names must be quoted or table-qualified to prevent evaluating PostgreSQL session functions
          const contextRes = await dispAdminClient.query(
            'SELECT "migration_name", "session_user", "current_user", "current_role" FROM "_migration_execution_context";'
          );
          expect(contextRes.rows[0].migration_name).toBe("20261105000000_init");
          expect(contextRes.rows[0].session_user).toBe("verirelease_deployer");
          expect(contextRes.rows[0].current_user).toBe("verirelease_owner_role");
          expect(contextRes.rows[0].current_role).toBe("verirelease_owner_role");

          // 4. Verify intended ownership of schema objects (tables, functions, types, and indexes)
          const ownershipRes = await dispAdminClient.query(`
            SELECT 'table' AS kind, tablename AS name, tableowner AS owner FROM pg_tables WHERE schemaname = 'public'
            UNION ALL
            SELECT 'function' AS kind, proname AS name, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace = 'public'::regnamespace
            UNION ALL
            SELECT 'type' AS kind, typname AS name, pg_get_userbyid(typowner) AS owner FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
            UNION ALL
            SELECT 'index' AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'i' AND n.nspname = 'public';
          `);

          expect(ownershipRes.rows.length).toBeGreaterThanOrEqual(60);
          for (const row of ownershipRes.rows) {
            expect(row.owner).toBe("verirelease_owner_role");
          }

          // 5. Connect as verirelease_app_user and verify runtime security boundaries
          const appPool = new Pool({
            host: pgHost,
            port: pgPort,
            user: "verirelease_app_user",
            database: dispDb,
          });
          const appClient = await appPool.connect();

          try {
            const appRoleCheck = await appClient.query("SELECT session_user, current_user, current_role;");
            expect(appRoleCheck.rows[0].session_user).toBe("verirelease_app_user");
            expect(appRoleCheck.rows[0].current_user).toBe("verirelease_app_user");
            expect(appRoleCheck.rows[0].current_role).toBe("verirelease_app_user");

            // A. Runtime role CANNOT execute DDL
            await expect(
              appClient.query("CREATE TABLE public.bad_table (id INT);")
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('ALTER TABLE "Milestone" DROP COLUMN "title";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('DROP TABLE "Contract";')
            ).rejects.toMatchObject({ code: "42501" });

            // B. Runtime role CANNOT UPDATE or DELETE immutable records
            await expect(
              appClient.query('DELETE FROM "AuditLog";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('TRUNCATE TABLE "AuditLog";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('DELETE FROM "PaymentReconciliation";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('TRUNCATE TABLE "PaymentReconciliation";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('UPDATE "MilestoneSubmission" SET status = \'EVALUATED\';')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('DELETE FROM "MilestoneSubmission";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('TRUNCATE TABLE "MilestoneSubmission";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('DELETE FROM "AcceptanceCriterion";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('TRUNCATE TABLE "AcceptanceCriterion";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('DELETE FROM "PolicyEvaluation";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('TRUNCATE TABLE "PolicyEvaluation";')
            ).rejects.toMatchObject({ code: "42501" });

            // B2. Runtime role HAS NO ACCESS to _migration_execution_context (SELECT, INSERT, UPDATE, DELETE, TRUNCATE all denied)
            await expect(
              appClient.query('SELECT * FROM "_migration_execution_context";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query(
                'INSERT INTO "_migration_execution_context" ("migration_name", "session_user", "current_user", "current_role") VALUES (\'fake\', \'a\', \'b\', \'c\');'
              )
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('UPDATE "_migration_execution_context" SET "session_user" = \'hacked\';')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('DELETE FROM "_migration_execution_context";')
            ).rejects.toMatchObject({ code: "42501" });

            await expect(
              appClient.query('TRUNCATE TABLE "_migration_execution_context";')
            ).rejects.toMatchObject({ code: "42501" });

            const migPrivRes = await appClient.query(`
              SELECT
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'SELECT') AS can_select,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'INSERT') AS can_insert,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'UPDATE') AS can_update,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'DELETE') AS can_delete,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'TRUNCATE') AS can_truncate;
            `);
            expect(migPrivRes.rows[0].can_select).toBe(false);
            expect(migPrivRes.rows[0].can_insert).toBe(false);
            expect(migPrivRes.rows[0].can_update).toBe(false);
            expect(migPrivRes.rows[0].can_delete).toBe(false);
            expect(migPrivRes.rows[0].can_truncate).toBe(false);

            // Verify immutability trigger prevents modification or deletion even by owner/admin
            await expect(
              dispAdminClient.query('UPDATE "_migration_execution_context" SET "session_user" = \'tampered\';')
            ).rejects.toMatchObject({ code: "55000" });

            await expect(
              dispAdminClient.query('DELETE FROM "_migration_execution_context";')
            ).rejects.toMatchObject({ code: "55000" });

            // Re-run provision-database-roles.sql after migration and verify revocations persist
            await dispAdminClient.query(rolesSql);
            const migPrivAfterRerun = await dispAdminClient.query(`
              SELECT
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'SELECT') AS can_select,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'INSERT') AS can_insert,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'UPDATE') AS can_update,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'DELETE') AS can_delete,
                has_table_privilege('verirelease_app_user', '"_migration_execution_context"', 'TRUNCATE') AS can_truncate;
            `);
            expect(migPrivAfterRerun.rows[0].can_select).toBe(false);
            expect(migPrivAfterRerun.rows[0].can_insert).toBe(false);
            expect(migPrivAfterRerun.rows[0].can_update).toBe(false);
            expect(migPrivAfterRerun.rows[0].can_delete).toBe(false);
            expect(migPrivAfterRerun.rows[0].can_truncate).toBe(false);

            // C. Runtime role HAS intended ordinary DML permissions
            await appClient.query(`
              INSERT INTO "User" (id, email, name, role)
              VALUES ('u_c', 'c@t.com', 'Client', 'CLIENT'), ('u_d', 'd@t.com', 'Dev', 'DEVELOPER');
            `);

            await appClient.query(`
              INSERT INTO "Contract" (id, title, description, "clientId", "developerId", "totalAmountMinorUnits", currency, "githubRepoOwner", "githubRepoName")
              VALUES ('c1', 'T', 'D', 'u_c', 'u_d', 100000, 'USD', 'o', 'r');
            `);

            await appClient.query(`
              INSERT INTO "Milestone" (id, "contractId", title, description, "orderIndex", "amountMinorUnits", currency, status)
              VALUES ('m1', 'c1', 'M1', 'D', 1, 100000, 'USD', 'FUNDED');
            `);

            // Mutable table update works
            const updContract = await appClient.query(`
              UPDATE "Contract" SET description = 'Updated Description' WHERE id = 'c1' RETURNING description;
            `);
            expect(updContract.rows[0].description).toBe("Updated Description");

            // Select works
            const selRes = await appClient.query('SELECT COUNT(*) FROM "Contract";');
            expect(parseInt(selRes.rows[0].count, 10)).toBe(1);

            // Append-only audit insert works
            const auditIns = await appClient.query(`
              INSERT INTO "AuditLog" (id, "entityType", "entityId", "actorType", "actorUserId", action, "correlationId")
              VALUES ('a1', 'CONTRACT', 'c1', 'USER', 'u_c', 'CREATED', 'corr_1')
              RETURNING id;
            `);
            expect(auditIns.rows.length).toBe(1);

            // D. PolicyEvaluation lifecycle under runtime role
            await appClient.query(`
              INSERT INTO "MilestoneSubmission" (
                id, "milestoneId", "submissionNumber", "prNumber", "prCommitSha", "prUrl",
                "criteriaVersion", "criteriaSnapshot", "criteriaHash", "submittedById"
              ) VALUES (
                's1', 'm1', 1, 10, '${"e".repeat(40)}', 'https://github.com/o/r/pull/10',
                1, '[]'::jsonb, '${"f".repeat(64)}', 'u_d'
              );
            `);

            // Insert IN_PROGRESS evaluation works
            await appClient.query(`
              INSERT INTO "PolicyEvaluation" (
                id, "submissionId", "milestoneId", "criteriaHash", "evaluationNumber", status
              ) VALUES (
                'e1', 's1', 'm1', '${"f".repeat(64)}', 1, 'IN_PROGRESS'
              );
            `);

            // Update IN_PROGRESS evaluation works
            await appClient.query(`
              UPDATE "PolicyEvaluation" SET "policyVersion" = '1.0.2' WHERE id = 'e1';
            `);

            // Transition to COMPLETED works
            await appClient.query(`
              UPDATE "PolicyEvaluation"
              SET status = 'COMPLETED', decision = 'PASS', "decisionReason" = 'Verified',
                  evaluations = '[]'::jsonb, "completedAt" = NOW()
              WHERE id = 'e1';
            `);

            // Cannot update COMPLETED evaluation (trigger 55000)
            await expect(
              appClient.query('UPDATE "PolicyEvaluation" SET "decisionReason" = \'tamper\' WHERE id = \'e1\';')
            ).rejects.toMatchObject({ code: "55000" });

            // Cannot delete evaluation (role has no DELETE grant: 42501)
            await expect(
              appClient.query('DELETE FROM "PolicyEvaluation" WHERE id = \'e1\';')
            ).rejects.toMatchObject({ code: "42501" });

            // E. Payment currency mismatch is rejected by PostgreSQL under runtime role
            await expect(
              appClient.query(`
                INSERT INTO "PaymentTransaction" (
                  id, "milestoneId", "submissionId", "transactionType", status, "idempotencyKey",
                  "amountMinorUnits", currency, "attemptNumber"
                ) VALUES (
                  'tx_disp_bad_curr', 'm1', NULL, 'FUNDING_AUTHORIZATION', 'CREATED', 'idem_disp_bad_curr',
                  100000, 'EUR', 1
                );
              `)
            ).rejects.toMatchObject({
              code: "23503",
              constraint: "fk_payment_milestone_currency",
            });
          } finally {
            appClient.release();
            await appPool.end();
          }
        } finally {
          dispAdminClient.release();
          await dispPool.end();
        }

        // Clean up disposable database
        await rootClient.query(`DROP DATABASE IF EXISTS ${dispDb};`);
      } finally {
        if (rootClient) rootClient.release();
      }
    });
  });

  // --------------------------------------------------------------------------
  // SQL Parameterization and Role Rotation Safety
  // --------------------------------------------------------------------------
  describe("SQL Parameterization and Role Rotation Safety", () => {
    const credDb = "verirelease_cred_test";
    const pgHost = process.env.PGHOST || "/tmp";
    const pgPort = parseInt(process.env.PGPORT || "5433", 10);

    it("Safely parameterizes credentials with special characters via session configuration and verifies SCRAM storage", async () => {
      const rootClient = await pool.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${credDb};`);
        await rootClient.query(`CREATE DATABASE ${credDb};`);

        const credAdminPool = new Pool({
          host: pgHost,
          port: pgPort,
          user: "postgres",
          database: credDb,
        });
        const credAdminClient = await credAdminPool.connect();

        try {
          const initialDeployerPw = 'p@$$\'w"o;rd\'#1!&';
          const initialAppUserPw = 'app@$$\'w"o;rd\'#1!&';

          // 1. Provision roles with special characters using session configuration (simulating psql \getenv + set_config)
          await credAdminClient.query(
            "SELECT set_config('verirelease.deployer_password', $1, false);",
            [initialDeployerPw]
          );
          await credAdminClient.query(
            "SELECT set_config('verirelease.app_user_password', $1, false);",
            [initialAppUserPw]
          );

          const fs = await import("node:fs");
          const path = await import("node:path");
          const rolesSql = fs.readFileSync(
            path.resolve(process.cwd(), "scripts/provision-database-roles.sql"),
            "utf8"
          );
          await credAdminClient.query(rolesSql);

          // 2. Verify SCRAM password hashes stored in pg_authid
          const authRes = await credAdminClient.query(`
            SELECT rolname, rolpassword LIKE 'SCRAM-SHA-256$%' AS is_scram
            FROM pg_authid
            WHERE rolname IN ('verirelease_deployer', 'verirelease_app_user');
          `);
          expect(authRes.rows.length).toBe(2);
          for (const row of authRes.rows) {
            expect(row.is_scram).toBe(true);
          }

          // 3. Authenticate with initial special-character credentials
          const deployerPool1 = new Pool({
            host: pgHost,
            port: pgPort,
            user: "verirelease_deployer",
            password: initialDeployerPw,
            database: credDb,
          });
          const dClient1 = await deployerPool1.connect();
          const dRole1 = await dClient1.query("SELECT session_user, current_user, current_role;");
          expect(dRole1.rows[0].session_user).toBe("verirelease_deployer");
          expect(dRole1.rows[0].current_user).toBe("verirelease_owner_role");
          expect(dRole1.rows[0].current_role).toBe("verirelease_owner_role");
          dClient1.release();
          await deployerPool1.end();

          const appPool1 = new Pool({
            host: pgHost,
            port: pgPort,
            user: "verirelease_app_user",
            password: initialAppUserPw,
            database: credDb,
          });
          const aClient1 = await appPool1.connect();
          const aRole1 = await aClient1.query("SELECT session_user, current_user, current_role;");
          expect(aRole1.rows[0].session_user).toBe("verirelease_app_user");
          expect(aRole1.rows[0].current_user).toBe("verirelease_app_user");
          expect(aRole1.rows[0].current_role).toBe("verirelease_app_user");
          aClient1.release();
          await appPool1.end();

          // 4. Rotate credentials for BOTH roles with new special characters
          const rotatedDeployerPw = 'r0t@t3d;\'"s3cr3t!#2_deployer';
          const rotatedAppUserPw = 'r0t@t3d;\'"s3cr3t!#2_app';

          await credAdminClient.query(
            "SELECT set_config('verirelease.deployer_password', $1, false);",
            [rotatedDeployerPw]
          );
          await credAdminClient.query(
            "SELECT set_config('verirelease.app_user_password', $1, false);",
            [rotatedAppUserPw]
          );
          await credAdminClient.query(`
            DO $$
            DECLARE
              v_d_pw TEXT := current_setting('verirelease.deployer_password', true);
              v_a_pw TEXT := current_setting('verirelease.app_user_password', true);
            BEGIN
              IF v_d_pw IS NOT NULL AND v_d_pw <> '' THEN
                EXECUTE format('ALTER ROLE verirelease_deployer WITH PASSWORD %L', v_d_pw);
              END IF;
              IF v_a_pw IS NOT NULL AND v_a_pw <> '' THEN
                EXECUTE format('ALTER ROLE verirelease_app_user WITH PASSWORD %L', v_a_pw);
              END IF;
            END
            $$;
          `);

          // 5. Authenticate with rotated credentials
          const deployerPool2 = new Pool({
            host: pgHost,
            port: pgPort,
            user: "verirelease_deployer",
            password: rotatedDeployerPw,
            database: credDb,
          });
          const dClient2 = await deployerPool2.connect();
          const dRole2 = await dClient2.query("SELECT session_user, current_user, current_role;");
          expect(dRole2.rows[0].session_user).toBe("verirelease_deployer");
          expect(dRole2.rows[0].current_user).toBe("verirelease_owner_role");
          expect(dRole2.rows[0].current_role).toBe("verirelease_owner_role");
          dClient2.release();
          await deployerPool2.end();

          const appPool2 = new Pool({
            host: pgHost,
            port: pgPort,
            user: "verirelease_app_user",
            password: rotatedAppUserPw,
            database: credDb,
          });
          const aClient2 = await appPool2.connect();
          const aRole2 = await aClient2.query("SELECT session_user, current_user, current_role;");
          expect(aRole2.rows[0].session_user).toBe("verirelease_app_user");
          expect(aRole2.rows[0].current_user).toBe("verirelease_app_user");
          expect(aRole2.rows[0].current_role).toBe("verirelease_app_user");
          aClient2.release();
          await appPool2.end();
        } finally {
          credAdminClient.release();
          await credAdminPool.end();
          await rootClient.query(`DROP DATABASE IF EXISTS ${credDb};`);
        }
      } finally {
        if (rootClient) rootClient.release();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Genuine Password-Authenticated PGPASSFILE and Stdin Provisioning Workflow
  // (Executed in an Isolated Disposable PostgreSQL Instance with Dedicated pg_hba.conf)
  // --------------------------------------------------------------------------
  describe("Genuine Password-Authenticated PGPASSFILE and Stdin Provisioning Workflow", () => {
    const psqlDb = "verirelease_psql_flow_test";
    const testAdminUser = "verirelease_psql_test_admin";
    const testAdminPw = "Adm1n#P@ss:w\\ord;test#1!";
    const dispPort = 5434;

    it("Executes provision-database-roles.sql via psql with genuine PGPASSFILE password authentication and stdin without CLI credentials in an isolated disposable instance", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      const { execSync, spawnSync } = await import("node:child_process");

      const pgBinDir = "/usr/lib/postgresql/18/bin";
      const dispDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "verirelease-disp-pgdata-"));
      const dispSockDir = fs.mkdtempSync(path.join(os.tmpdir(), "verirelease-disp-sock-"));
      const dispLogFile = path.join(dispDataDir, "postgres.log");

      let serverStarted = false;

      try {
        // 1. Initialize dedicated disposable PostgreSQL cluster (completely isolated from shared test server)
        execSync(`"${path.join(pgBinDir, "initdb")}" -D "${dispDataDir}" -U postgres`, {
          stdio: "pipe",
          encoding: "utf8",
        });

        // 2. Configure dedicated pg_hba.conf in disposable cluster requiring SCRAM-SHA-256 for testAdminUser
        // Note: The shared test server's active pg_hba.conf is NEVER modified.
        const hbaContent =
          `local all postgres trust\n` +
          `local all ${testAdminUser} scram-sha-256\n` +
          `local all all trust\n`;
        fs.writeFileSync(path.join(dispDataDir, "pg_hba.conf"), hbaContent, "utf8");

        // 3. Start dedicated disposable server on isolated Unix socket directory and port 5434
        execSync(
          `"${path.join(pgBinDir, "pg_ctl")}" -D "${dispDataDir}" -o "-k \\"${dispSockDir}\\" -p ${dispPort} -h ''" -l "${dispLogFile}" start`,
          { stdio: "pipe", encoding: "utf8" }
        );
        serverStarted = true;

        // 4. Verify disposable server is ready to accept connections
        execSync(`"${path.join(pgBinDir, "pg_isready")}" -h "${dispSockDir}" -p ${dispPort}`, {
          stdio: "pipe",
          encoding: "utf8",
        });

        // 5. Connect as bootstrap superuser to provision non-superuser test admin role
        const rootPool = new Pool({
          host: dispSockDir,
          port: dispPort,
          user: "postgres",
          database: "postgres",
        });
        const rootClient = await rootPool.connect();

        try {
          const escapedSqlPw = testAdminPw.replace(/'/g, "''");
          // Requirement 2: Grant ONLY necessary privileges (LOGIN CREATEROLE CREATEDB) - ZERO SUPERUSER
          await rootClient.query(
            `CREATE ROLE ${testAdminUser} WITH LOGIN CREATEROLE CREATEDB PASSWORD '${escapedSqlPw}';`
          );

          // Verify that testAdminUser is strictly NOT a superuser
          const roleCheck = await rootClient.query(
            `SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = '${testAdminUser}';`
          );
          expect(roleCheck.rows[0].rolsuper).toBe(false);
          expect(roleCheck.rows[0].rolcreaterole).toBe(true);
          expect(roleCheck.rows[0].rolcreatedb).toBe(true);

          await rootClient.query(`CREATE DATABASE ${psqlDb} OWNER ${testAdminUser};`);

          // Bootstrap owner role and grant to testAdminUser with admin option so it can assign schema ownership
          await rootClient.query(
            `CREATE ROLE verirelease_owner_role NOLOGIN; ` +
            `GRANT verirelease_owner_role TO ${testAdminUser} WITH ADMIN OPTION;`
          );
        } finally {
          rootClient.release();
          await rootPool.end();
        }

        // Common psql CLI arguments: strictly host socket, port, user, db - ZERO credentials or URLs
        const psqlArgs = ["-h", dispSockDir, "-p", dispPort.toString(), "-U", testAdminUser, "-d", psqlDb];

        // Verify that CLI arguments do not contain any passwords or credentials
        expect(psqlArgs.every((arg) => !arg.includes(testAdminPw))).toBe(true);

        // 6. Test Failure: Wrong password in PGPASSFILE must fail authentication
        const wrongPassFile = path.join(dispDataDir, ".pgpass_wrong");
        fs.writeFileSync(
          wrongPassFile,
          `*:${dispPort}:*:${testAdminUser}:wrong_password_attempt\n`,
          { mode: 0o600, flag: "w" }
        );
        const wrongStat = fs.statSync(wrongPassFile);
        expect(wrongStat.mode & 0o777).toBe(0o600);

        const wrongRes = spawnSync("psql", psqlArgs, {
          encoding: "utf8",
          env: {
            ...process.env,
            PGPASSFILE: wrongPassFile,
          },
        });
        expect(wrongRes.status).not.toBe(0);
        expect(wrongRes.stderr).toContain("password authentication failed");
        fs.unlinkSync(wrongPassFile);

        // 7. Test Success: Correct password with escaped colons and backslashes in 0600 PGPASSFILE
        const correctPassFile = path.join(dispDataDir, ".pgpass_correct");
        // In .pgpass format, colons and backslashes in password must be escaped with a backslash
        const pgpassEscapedPw = testAdminPw.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
        fs.writeFileSync(
          correctPassFile,
          `*:${dispPort}:*:${testAdminUser}:${pgpassEscapedPw}\n`,
          { mode: 0o600, flag: "w" }
        );
        const correctStat = fs.statSync(correctPassFile);
        expect(correctStat.mode & 0o777).toBe(0o600);

        const deployerPw = "test_deployer_pw_$#1;";
        const appUserPw = "test_app_pw_$#2;";

        // Provide SQL commands via stdin stream to psql
        const stdinScript = `
\\set ON_ERROR_STOP on
\\o /dev/null
SELECT set_config('verirelease.deployer_password', '${deployerPw}', false);
SELECT set_config('verirelease.app_user_password', '${appUserPw}', false);
\\o
\\i scripts/provision-database-roles.sql
`;

        const correctRes = spawnSync("psql", psqlArgs, {
          input: stdinScript,
          encoding: "utf8",
          env: {
            ...process.env,
            PGPASSFILE: correctPassFile,
          },
        });

        expect(correctRes.status).toBe(0);
        fs.unlinkSync(correctPassFile);

        // 8. Verify that provisioned roles authenticate and operate with correct roles
        const deployerPool = new Pool({
          host: dispSockDir,
          port: dispPort,
          user: "verirelease_deployer",
          password: deployerPw,
          database: psqlDb,
        });
        const dClient = await deployerPool.connect();
        const dRole = await dClient.query("SELECT session_user, current_user, current_role;");
        expect(dRole.rows[0].session_user).toBe("verirelease_deployer");
        expect(dRole.rows[0].current_user).toBe("verirelease_owner_role");
        dClient.release();
        await deployerPool.end();

        const appPool = new Pool({
          host: dispSockDir,
          port: dispPort,
          user: "verirelease_app_user",
          password: appUserPw,
          database: psqlDb,
        });
        const aClient = await appPool.connect();
        const aRole = await aClient.query("SELECT session_user, current_user, current_role;");
        expect(aRole.rows[0].session_user).toBe("verirelease_app_user");
        aClient.release();
        await appPool.end();
      } finally {
        // Requirement 3: Cleanup fails visibly without swallowing errors
        let cleanupError: Error | null = null;

        if (serverStarted) {
          try {
            execSync(`"${path.join(pgBinDir, "pg_ctl")}" -D "${dispDataDir}" -m immediate stop`, {
              stdio: "pipe",
              encoding: "utf8",
            });
          } catch (e: any) {
            cleanupError = e;
          }
        }

        try {
          if (fs.existsSync(dispDataDir)) {
            fs.rmSync(dispDataDir, { recursive: true, force: true });
          }
        } catch (e: any) {
          if (!cleanupError) cleanupError = e;
        }

        try {
          if (fs.existsSync(dispSockDir)) {
            fs.rmSync(dispSockDir, { recursive: true, force: true });
          }
        } catch (e: any) {
          if (!cleanupError) cleanupError = e;
        }

        if (cleanupError) {
          throw cleanupError;
        }
      }
    });
  });
});
