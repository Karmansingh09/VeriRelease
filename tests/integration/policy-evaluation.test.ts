/**
 * VeriRelease Policy Evaluation Integration Test Suite
 *
 * Verifies end-to-end integration of the deterministic policy evaluation engine,
 * policy evaluation persistence, sequential numbering, milestone state transitions,
 * and database-level immutability enforcement.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { prisma } from "../../src/lib/prisma";
import {
  PrismaContractRepository,
  PrismaMilestoneRepository,
  PrismaSubmissionRepository,
} from "../../src/modules/contracts";
import {
  PrismaPolicyRepository,
  PolicyEvaluationService,
} from "../../src/modules/policy";
import { hashCanonicalJson } from "../../src/modules/common/canonical-json";
import {
  DomainValidationError,
  DomainNotFoundError,
  InvalidStateTransitionError,
} from "../../src/modules/common/errors";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("Deterministic Policy Evaluation Engine Integration Test Suite", () => {
  let pgClient: PoolClient;
  let contractRepo: PrismaContractRepository;
  let milestoneRepo: PrismaMilestoneRepository;
  let submissionRepo: PrismaSubmissionRepository;
  let policyRepo: PrismaPolicyRepository;
  let policyService: PolicyEvaluationService;

  beforeAll(async () => {
    pgClient = await pool.connect();
    contractRepo = new PrismaContractRepository(prisma);
    milestoneRepo = new PrismaMilestoneRepository(prisma);
    submissionRepo = new PrismaSubmissionRepository(prisma);
    policyRepo = new PrismaPolicyRepository(prisma);
    policyService = new PolicyEvaluationService(
      policyRepo,
      milestoneRepo,
      submissionRepo,
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
    const clientId = "usr_client_peval_01";
    const devId = "usr_dev_peval_01";

    await pgClient.query(`
      INSERT INTO "User" (id, email, name, role)
      VALUES 
        ('${clientId}', 'client@peval.test', 'Client User', 'CLIENT'),
        ('${devId}', 'dev@peval.test', 'Dev User', 'DEVELOPER');
    `);

    return { clientId, devId };
  }

  async function setupSubmittedMilestone() {
    const { clientId, devId } = await seedUsers();

    const contract = await contractRepo.create({
      title: "Policy Evaluation Contract",
      description: "Contract description",
      clientId,
      developerId: devId,
      totalAmountMinorUnits: 1000000n,
      currency: "USD",
      githubRepoOwner: "acme",
      githubRepoName: "webapp",
    });

    const milestone = await milestoneRepo.create({
      contractId: contract.id,
      title: "Core API Milestone",
      description: "Deliver core API and integration tests",
      orderIndex: 1,
      amountMinorUnits: 500000n,
      currency: "USD",
      criteria: [
        {
          orderIndex: 1,
          title: "Unit Test Suite",
          description: "All unit tests in tests/unit must pass cleanly",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
        {
          orderIndex: 2,
          title: "Lint and Typecheck",
          description: "Zero ESLint warnings and zero TypeScript errors",
          criterionType: "CODE_QUALITY",
          isMandatory: true,
        },
        {
          orderIndex: 3,
          title: "Documentation Benchmark",
          description: "API documentation updated with OpenAPI spec",
          criterionType: "SPECIFICATION",
          isMandatory: false,
        },
      ],
    });

    await milestoneRepo.updateStatus(milestone.id, "FUNDED");

    const submission = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 42,
      prCommitSha: "4242424242424242424242424242424242424242",
      prUrl: "https://github.com/acme/webapp/pull/42",
      submittedById: devId,
    });

    return { clientId, devId, contract, milestone, submission };
  }

  // ==========================================================================
  // 1. Successful Evaluation & Passing Outcome
  // ==========================================================================
  it("persists a completed PASS policy evaluation and transitions milestone to ELIGIBLE_FOR_PAYOUT", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const criteriaSnapshot = submission.criteriaSnapshot;
    expect(criteriaSnapshot).toHaveLength(3);

    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { testCount: 42, passed: 42 },
      },
      {
        criterionId: criteriaSnapshot[1]!.criterionId,
        passed: true,
        evidence: { lintErrors: 0, tsErrors: 0 },
      },
      {
        criterionId: criteriaSnapshot[2]!.criterionId,
        passed: true,
        evidence: { specUrl: "https://acme.test/openapi.json" },
      },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    // 1. Verify returned result structure
    expect(result.evaluationResult.decision).toBe("PASS");
    expect(result.evaluation.status).toBe("COMPLETED");
    expect(result.evaluation.decision).toBe("PASS");
    expect(result.evaluation.evaluationNumber).toBe(1);
    expect(result.evaluation.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.milestone.status).toBe("ELIGIBLE_FOR_PAYOUT");
    expect(result.transitionResult.newStatus).toBe("ELIGIBLE_FOR_PAYOUT");
    expect(result.transitionResult.auditAction).toBe("POLICY_EVALUATION_APPROVED");

    // 2. Verify database records
    const dbEval = await prisma.policyEvaluation.findUnique({
      where: { id: result.evaluation.id },
    });
    expect(dbEval).not.toBeNull();
    expect(dbEval!.status).toBe("COMPLETED");
    expect(dbEval!.decision).toBe("PASS");
    expect(dbEval!.evaluationNumber).toBe(1);
    expect(dbEval!.completedAt).not.toBeNull();
    expect(Array.isArray(dbEval!.evaluations)).toBe(true);
    expect((dbEval!.evaluations as any[]).length).toBe(3);

    const dbMilestone = await prisma.milestone.findUnique({
      where: { id: milestone.id },
    });
    expect(dbMilestone!.status).toBe("ELIGIBLE_FOR_PAYOUT");
  });

  // ==========================================================================
  // 2. Failing Evaluation & Changes Requested Outcome
  // ==========================================================================
  it("persists a completed FAIL policy evaluation and transitions milestone to CHANGES_REQUESTED when mandatory criterion fails", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { testCount: 42, passed: 42 },
      },
      {
        criterionId: criteriaSnapshot[1]!.criterionId, // Mandatory criterion fails!
        passed: false,
        reason: "ESLint found 3 unused variables and 1 any type",
        evidence: { errorCount: 4 },
      },
      {
        criterionId: criteriaSnapshot[2]!.criterionId,
        passed: true,
      },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    // 1. Verify returned result structure
    expect(result.evaluationResult.decision).toBe("FAIL");
    expect(result.evaluation.status).toBe("COMPLETED");
    expect(result.evaluation.decision).toBe("FAIL");
    expect(result.evaluation.decisionReason).toContain("Lint and Typecheck");
    expect(result.milestone.status).toBe("CHANGES_REQUESTED");
    expect(result.transitionResult.newStatus).toBe("CHANGES_REQUESTED");
    expect(result.transitionResult.auditAction).toBe("CHANGES_REQUESTED");

    // 2. Verify database records
    const dbEval = await prisma.policyEvaluation.findUnique({
      where: { id: result.evaluation.id },
    });
    expect(dbEval!.status).toBe("COMPLETED");
    expect(dbEval!.decision).toBe("FAIL");

    const dbMilestone = await prisma.milestone.findUnique({
      where: { id: milestone.id },
    });
    expect(dbMilestone!.status).toBe("CHANGES_REQUESTED");
  });

  // ==========================================================================
  // 3. Optional Criterion Failure Does Not Block Approval
  // ==========================================================================
  it("approves policy and transitions to ELIGIBLE_FOR_PAYOUT when only an optional criterion fails", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const criteriaSnapshot = submission.criteriaSnapshot;
    const assessments = [
      {
        criterionId: criteriaSnapshot[0]!.criterionId,
        passed: true,
      },
      {
        criterionId: criteriaSnapshot[1]!.criterionId,
        passed: true,
      },
      {
        criterionId: criteriaSnapshot[2]!.criterionId, // Optional criterion fails
        passed: false,
        reason: "OpenAPI spec docs incomplete",
      },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    expect(result.evaluationResult.decision).toBe("PASS");
    expect(result.evaluation.decision).toBe("PASS");
    expect(result.milestone.status).toBe("ELIGIBLE_FOR_PAYOUT");

    // Breakdown records individual failure accurately
    const evals = result.evaluation.evaluations as any[];
    expect(evals[2].criterionId).toBe(criteriaSnapshot[2]!.criterionId);
    expect(evals[2].passed).toBe(false);
  });

  // ==========================================================================
  // 4. Invalid Milestone Transitions Are Rejected
  // ==========================================================================
  it("rejects evaluation when milestone is not in a submittable/evaluating state (e.g. FUNDED)", async () => {
    const { clientId, devId } = await seedUsers();

    const contract = await contractRepo.create({
      title: "Contract",
      description: "Desc",
      clientId,
      developerId: devId,
      totalAmountMinorUnits: 500000n,
      currency: "USD",
      githubRepoOwner: "acme",
      githubRepoName: "webapp",
    });

    const milestone = await milestoneRepo.create({
      contractId: contract.id,
      title: "Milestone",
      description: "Desc",
      orderIndex: 1,
      amountMinorUnits: 200000n,
      currency: "USD",
      criteria: [
        {
          orderIndex: 1,
          title: "Criterion",
          description: "Desc",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    await milestoneRepo.updateStatus(milestone.id, "FUNDED");

    const submission = await submissionRepo.createSubmission({
      milestoneId: milestone.id,
      prNumber: 1,
      prCommitSha: "1111111111111111111111111111111111111111",
      prUrl: "https://github.com/acme/webapp/pull/1",
      submittedById: devId,
    });

    // Manually force milestone back to FUNDED to test invalid transition guard
    await pgClient.query(`UPDATE "Milestone" SET status = 'FUNDED' WHERE id = '${milestone.id}';`);

    const assessments = [
      {
        criterionId: submission.criteriaSnapshot[0]!.criterionId,
        passed: true,
      },
    ];

    // Transitioning from FUNDED -> EVALUATING is disallowed by state graph
    await expect(
      policyService.evaluateSubmission({
        submissionId: submission.id,
        assessments,
      })
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  it("rejects evaluation when milestone is in a terminal DISPUTED state", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    // Transition milestone to DISPUTED
    await pgClient.query(`UPDATE "Milestone" SET status = 'DISPUTED' WHERE id = '${milestone.id}';`);

    const assessments = [
      { criterionId: submission.criteriaSnapshot[0]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[2]!.criterionId, passed: true },
    ];

    await expect(
      policyService.evaluateSubmission({
        submissionId: submission.id,
        assessments,
      })
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // ==========================================================================
  // 5. Immutability of Completed PolicyEvaluations
  // ==========================================================================
  it("enforces immutability: completed PolicyEvaluation records cannot be updated or deleted", async () => {
    const { submission } = await setupSubmittedMilestone();

    const assessments = [
      { criterionId: submission.criteriaSnapshot[0]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[2]!.criterionId, passed: true },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments,
    });

    const evalId = result.evaluation.id;

    // 1. Application-level repository check blocks update
    await expect(
      policyRepo.updateEvaluation(evalId, {
        status: "COMPLETED",
        decision: "FAIL",
      })
    ).rejects.toThrow(/already COMPLETED and strictly immutable/);

    // 2. Database trigger blocks raw SQL UPDATE
    await expect(
      pgClient.query(`UPDATE "PolicyEvaluation" SET decision = 'FAIL' WHERE id = '${evalId}';`)
    ).rejects.toThrow(/SECURITY VIOLATION: Completed PolicyEvaluation records are strictly immutable/);

    // 3. Database trigger blocks raw SQL DELETE
    await expect(
      pgClient.query(`DELETE FROM "PolicyEvaluation" WHERE id = '${evalId}';`)
    ).rejects.toThrow(/SECURITY VIOLATION: Completed PolicyEvaluation records are strictly immutable/);
  });

  // ==========================================================================
  // 6. Sequential Evaluation Numbering
  // ==========================================================================
  it("assigns sequential evaluation numbers across multiple evaluation executions for the same submission", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    // Start evaluation 1 manually in progress
    const eval1 = await policyRepo.createEvaluation({
      submissionId: submission.id,
      milestoneId: milestone.id,
      criteriaHash: submission.criteriaHash,
    });
    expect(eval1.evaluationNumber).toBe(1);

    // Start evaluation 2 for the same submission
    const eval2 = await policyRepo.createEvaluation({
      submissionId: submission.id,
      milestoneId: milestone.id,
      criteriaHash: submission.criteriaHash,
    });
    expect(eval2.evaluationNumber).toBe(2);

    const allEvals = await policyService.getEvaluationsForSubmission(submission.id);
    expect(allEvals).toHaveLength(2);
    expect(allEvals[0]!.evaluationNumber).toBe(1);
    expect(allEvals[1]!.evaluationNumber).toBe(2);

    const latest = await policyService.getLatestEvaluation(submission.id);
    expect(latest).not.toBeNull();
    expect(latest!.evaluationNumber).toBe(2);
  });

  // ==========================================================================
  // 7. Atomic Rollback on Malformed Assessments
  // ==========================================================================
  it("rolls back completely and persists no records when assessments contain an unknown criterion ID", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const rogueAssessments = [
      { criterionId: submission.criteriaSnapshot[0]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true },
      { criterionId: "crit_unknown_999", passed: true }, // Invalid!
    ];

    await expect(
      policyService.evaluateSubmission({
        submissionId: submission.id,
        assessments: rogueAssessments,
      })
    ).rejects.toThrow(DomainValidationError);

    // Assert zero policy evaluations were persisted
    const evaluations = await policyRepo.findBySubmissionId(submission.id);
    expect(evaluations).toHaveLength(0);

    // Assert milestone remains in SUBMITTED state (unaffected by rolled back evaluation)
    const milestoneAfter = await milestoneRepo.findById(milestone.id);
    expect(milestoneAfter!.status).toBe("SUBMITTED");
  });

  // ==========================================================================
  // 8. Authoritative Snapshot Preservation Across Criteria Amendments
  // ==========================================================================
  it("evaluates strictly against frozen submission snapshot even after milestone criteria are amended to a new version", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    expect(submission.criteriaVersion).toBe(1);

    // Amend milestone criteria to Version 2 (activeCriteriaVersion becomes 2)
    const amended = await milestoneRepo.amendCriteria(milestone.id, [
      {
        orderIndex: 1,
        title: "Version 2 Rewritten Spec",
        description: "New requirements",
        criterionType: "SPECIFICATION",
        isMandatory: true,
      },
    ]);
    expect(amended.activeCriteriaVersion).toBe(2);

    // The submission's snapshot from Version 1 remains authoritative
    const v1Assessments = [
      { criterionId: submission.criteriaSnapshot[0]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[2]!.criterionId, passed: true },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments: v1Assessments,
    });

    expect(result.evaluationResult.decision).toBe("PASS");
    expect(result.milestone.status).toBe("ELIGIBLE_FOR_PAYOUT");
    expect(result.evaluation.criteriaHash).toBe(submission.criteriaHash);
  });

  // ==========================================================================
  // 9. Receipt Hash Integrity & Caller Override Rejection
  // ==========================================================================
  it("rejects invalid evidence during evaluation even when a caller supplies a valid-looking 64-hex receipt hash", async () => {
    const { submission } = await setupSubmittedMilestone();

    const fakeReceiptHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const invalidEvidenceAssessments = [
      {
        criterionId: submission.criteriaSnapshot[0]!.criterionId,
        passed: true,
        evidence: { metrics: { score: NaN } }, // NaN is rejected by recursive evidence validation!
      },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[2]!.criterionId, passed: true },
    ];

    await expect(
      policyService.evaluateSubmission({
        submissionId: submission.id,
        assessments: invalidEvidenceAssessments,
        receiptHash: fakeReceiptHash,
      })
    ).rejects.toThrow(/Cannot canonicalize non-finite number: NaN/);

    // Verify zero records were created
    const evals = await policyRepo.findBySubmissionId(submission.id);
    expect(evals).toHaveLength(0);
  });

  it("rejects an incorrect caller-supplied receiptHash that does not match authoritative calculation", async () => {
    const { submission } = await setupSubmittedMilestone();

    const mismatchedReceiptHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const validAssessments = [
      { criterionId: submission.criteriaSnapshot[0]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true },
      { criterionId: submission.criteriaSnapshot[2]!.criterionId, passed: true },
    ];

    await expect(
      policyService.evaluateSubmission({
        submissionId: submission.id,
        assessments: validAssessments,
        receiptHash: mismatchedReceiptHash,
      })
    ).rejects.toThrow(/Receipt hash mismatch: caller-supplied receiptHash/);

    // Verify zero records were committed
    const evals = await policyRepo.findBySubmissionId(submission.id);
    expect(evals).toHaveLength(0);
  });

  it("authoritative receipt hash is always computed internally and equals the canonical SHA-256 digest", async () => {
    const { milestone, submission } = await setupSubmittedMilestone();

    const validAssessments = [
      { criterionId: submission.criteriaSnapshot[0]!.criterionId, passed: true, evidence: { tests: 10 } },
      { criterionId: submission.criteriaSnapshot[1]!.criterionId, passed: true, evidence: { linter: "clean" } },
      { criterionId: submission.criteriaSnapshot[2]!.criterionId, passed: true, evidence: { doc: true } },
    ];

    const result = await policyService.evaluateSubmission({
      submissionId: submission.id,
      assessments: validAssessments,
    });

    const expectedReceiptHash = hashCanonicalJson({
      submissionId: submission.id,
      milestoneId: milestone.id,
      criteriaHash: submission.criteriaHash,
      evaluationNumber: result.evaluation.evaluationNumber,
      decision: result.evaluation.decision,
      evaluations: result.evaluation.evaluations,
    });

    expect(result.evaluation.receiptHash).toBe(expectedReceiptHash);

    // Verify persisted database record matches the authoritative canonical hash
    const dbRecord = await prisma.policyEvaluation.findUnique({
      where: { id: result.evaluation.id },
    });
    expect(dbRecord!.receiptHash).toBe(expectedReceiptHash);
  });
});
