import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { prisma, type DbClient } from "../../src/lib/prisma";
import {
  PrismaContractRepository,
  PrismaMilestoneRepository,
  PrismaSubmissionRepository,
} from "../../src/modules/contracts";
import { PrismaPolicyRepository } from "../../src/modules/policy";
import { hashCanonicalJson } from "../../src/modules/common/canonical-json";
import {
  DomainNotFoundError,
  DomainValidationError,
  InvalidStateTransitionError,
} from "../../src/modules/common/errors";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("Repository Layer & Criteria Snapshotting Integration Test Suite", () => {
  let pgClient: PoolClient;
  let contractRepo: PrismaContractRepository;
  let milestoneRepo: PrismaMilestoneRepository;
  let submissionRepo: PrismaSubmissionRepository;
  let policyRepo: PrismaPolicyRepository;

  function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function waitForPidLockWait(
    pid: number,
    timeoutMs = 2000
  ): Promise<{ isLocked: boolean; waitEventType: string | null; state: string | null }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await pgClient.query(
        `SELECT wait_event_type, state FROM pg_stat_activity WHERE pid = $1;`,
        [pid]
      );
      const row = res.rows[0];
      if (row && row.wait_event_type === "Lock" && row.state === "active") {
        return { isLocked: true, waitEventType: row.wait_event_type, state: row.state };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const finalRes = await pgClient.query(
      `SELECT wait_event_type, state FROM pg_stat_activity WHERE pid = $1;`,
      [pid]
    );
    const row = finalRes.rows[0];
    return {
      isLocked: row?.wait_event_type === "Lock" && row?.state === "active",
      waitEventType: row?.wait_event_type ?? null,
      state: row?.state ?? null,
    };
  }

  async function awaitSignal<T>(
    signal: { promise: Promise<T> },
    failingPromise?: Promise<unknown>,
    timeoutMs = 5000,
    description = "Signal"
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`));
      }, timeoutMs);
    });

    const failureMonitor = failingPromise
      ? failingPromise.then(
          () => new Promise<never>(() => {}),
          (err) => Promise.reject(err)
        )
      : null;

    try {
      const races: Promise<any>[] = [signal.promise, timeoutPromise];
      if (failureMonitor) {
        races.push(failureMonitor);
      }
      return await Promise.race(races);
    } finally {
      clearTimeout(timer!);
    }
  }

  beforeAll(async () => {
    pgClient = await pool.connect();
    contractRepo = new PrismaContractRepository(prisma);
    milestoneRepo = new PrismaMilestoneRepository(prisma);
    submissionRepo = new PrismaSubmissionRepository(prisma);
    policyRepo = new PrismaPolicyRepository(prisma);
  });

  afterAll(async () => {
    if (pgClient) pgClient.release();
    await pool.end();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean slate between tests
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
    const clientId = "usr_client_repo_01";
    const devId = "usr_dev_repo_01";

    await pgClient.query(`
      INSERT INTO "User" (id, email, name, role)
      VALUES 
        ('${clientId}', 'client@repo.test', 'Client User', 'CLIENT'),
        ('${devId}', 'dev@repo.test', 'Dev User', 'DEVELOPER');
    `);

    return { clientId, devId };
  }

  // ==========================================================================
  // 1. Contract Repository Tests
  // ==========================================================================
  describe("Contract Repository", () => {
    it("creates and retrieves a valid contract", async () => {
      const { clientId, devId } = await seedUsers();

      const created = await contractRepo.create({
        title: "Test Web App",
        description: "Full stack web application",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 500000n, // $5,000.00
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      expect(created.id).toMatch(/^cnt_/);
      expect(created.title).toBe("Test Web App");
      expect(created.status).toBe("DRAFT");
      expect(created.totalAmountMinorUnits).toBe(500000n);

      const retrieved = await contractRepo.findById(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.totalAmountMinorUnits).toBe(500000n);
    });

    it("rejects contract creation when clientId equals developerId", async () => {
      const { clientId } = await seedUsers();

      await expect(
        contractRepo.create({
          title: "Self Contract",
          description: "Invalid",
          clientId,
          developerId: clientId,
          totalAmountMinorUnits: 100000n,
          currency: "USD",
          githubRepoOwner: "acme",
          githubRepoName: "webapp",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects contract creation with non-positive amount", async () => {
      const { clientId, devId } = await seedUsers();

      await expect(
        contractRepo.create({
          title: "Zero Contract",
          description: "Invalid",
          clientId,
          developerId: devId,
          totalAmountMinorUnits: 0n,
          currency: "USD",
          githubRepoOwner: "acme",
          githubRepoName: "webapp",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects contract creation when user does not exist", async () => {
      const { clientId } = await seedUsers();

      await expect(
        contractRepo.create({
          title: "Missing User Contract",
          description: "Invalid",
          clientId,
          developerId: "non_existent_dev",
          totalAmountMinorUnits: 100000n,
          currency: "USD",
          githubRepoOwner: "acme",
          githubRepoName: "webapp",
        })
      ).rejects.toThrow(DomainNotFoundError);
    });

    it("updates contract status and retrieves with milestones", async () => {
      const { clientId, devId } = await seedUsers();

      const contract = await contractRepo.create({
        title: "Status Test Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const updated = await contractRepo.updateStatus(contract.id, "ACTIVE");
      expect(updated.status).toBe("ACTIVE");

      // Add a milestone
      await milestoneRepo.create({
        contractId: contract.id,
        title: "Milestone 1",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
      });

      const withMilestones = await contractRepo.findByIdWithMilestones(contract.id);
      expect(withMilestones).not.toBeNull();
      expect(withMilestones!.milestones.length).toBe(1);
      expect(withMilestones!.milestones[0]!.title).toBe("Milestone 1");
    });
  });

  // ==========================================================================
  // 2. Milestone Repository Tests
  // ==========================================================================
  describe("Milestone Repository", () => {
    it("creates milestone with initial criteria (version 1) and retrieves it", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Milestone Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Core API",
        description: "Build core endpoints",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [
          {
            orderIndex: 1,
            title: "Unit tests",
            description: "All unit tests pass",
            criterionType: "AUTOMATED_TEST",
            isMandatory: true,
          },
          {
            orderIndex: 2,
            title: "Linter clean",
            description: "Zero lint errors",
            criterionType: "CODE_QUALITY",
            isMandatory: true,
          },
        ],
      });

      expect(milestone.id).toMatch(/^mls_/);
      expect(milestone.activeCriteriaVersion).toBe(1);
      expect(milestone.criteria.length).toBe(2);
      expect(milestone.criteria[0]!.version).toBe(1);

      const retrieved = await milestoneRepo.findByIdWithCriteria(milestone.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.criteria.length).toBe(2);
    });

    it("rejects milestone creation when currency does not match contract currency", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "USD Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      await expect(
        milestoneRepo.create({
          contractId: contract.id,
          title: "EUR Milestone",
          description: "Desc",
          orderIndex: 1,
          amountMinorUnits: 200000n,
          currency: "EUR",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects milestone creation that exceeds contract totalAmountMinorUnits via allocation trigger", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Budget Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 500000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      // Milestone 1 uses 400,000 of 500,000
      await milestoneRepo.create({
        contractId: contract.id,
        title: "Milestone 1",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
      });

      // Milestone 2 attempts to use 200,000 (total would be 600,000 > 500,000)
      await expect(
        milestoneRepo.create({
          contractId: contract.id,
          title: "Milestone 2",
          description: "Desc",
          orderIndex: 2,
          amountMinorUnits: 200000n,
          currency: "USD",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("amends criteria: increments activeCriteriaVersion to N + 1 and preserves historical versions", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Amendment Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Milestone 1",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [
          {
            orderIndex: 1,
            title: "Original Test",
            description: "Desc 1",
            criterionType: "AUTOMATED_TEST",
          },
        ],
      });

      expect(milestone.activeCriteriaVersion).toBe(1);

      // Amend criteria to version 2
      const amended = await milestoneRepo.amendCriteria(milestone.id, [
        {
          orderIndex: 1,
          title: "Amended Test",
          description: "New criteria spec",
          criterionType: "AUTOMATED_TEST",
        },
        {
          orderIndex: 2,
          title: "New Security Check",
          description: "Security scan must pass",
          criterionType: "CODE_QUALITY",
        },
      ]);

      expect(amended.activeCriteriaVersion).toBe(2);
      expect(amended.criteria.length).toBe(2);
      expect(amended.criteria[0]!.version).toBe(2);

      // Verify historical version 1 is still intact in DB
      const v1WithCriteria = await milestoneRepo.findByIdWithCriteria(milestone.id, 1);
      expect(v1WithCriteria!.criteria.length).toBe(1);
      expect(v1WithCriteria!.criteria[0]!.title).toBe("Original Test");

      // Verify active version 2 is retrieved by default
      const v2WithCriteria = await milestoneRepo.findByIdWithCriteria(milestone.id);
      expect(v2WithCriteria!.activeCriteriaVersion).toBe(2);
      expect(v2WithCriteria!.criteria.length).toBe(2);
      expect(v2WithCriteria!.criteria[0]!.title).toBe("Amended Test");
    });
  });

  // ==========================================================================
  // 3. Milestone Submission & Authoritative Criteria Snapshotting Tests
  // ==========================================================================
  describe("Milestone Submission & Criteria Snapshotting", () => {
    it("generates an immutable criteria snapshot and RFC 8785 hash strictly from authoritative DB records", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Snapshot Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Delivery Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [
          {
            orderIndex: 1,
            title: "Pass unit tests",
            description: "All tests pass",
            criterionType: "AUTOMATED_TEST",
            isMandatory: true,
          },
          {
            orderIndex: 2,
            title: "Lint clean",
            description: "Zero warnings",
            criterionType: "CODE_QUALITY",
            isMandatory: true,
          },
        ],
      });

      // Transition milestone to FUNDED state before developer submission
      await milestoneRepo.updateStatus(milestone.id, "FUNDED", new Date());

      const validSha = "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e";
      const submission = await submissionRepo.createSubmission({
        milestoneId: milestone.id,
        prNumber: 42,
        prCommitSha: validSha,
        prUrl: "https://github.com/acme/webapp/pull/42",
        submittedById: devId,
      });

      expect(submission.id).toMatch(/^sub_/);
      expect(submission.submissionNumber).toBe(1);
      expect(submission.criteriaVersion).toBe(1);
      expect(submission.status).toBe("PENDING");

      // Verify snapshot items match authoritative DB criteria
      expect(submission.criteriaSnapshot.length).toBe(2);
      expect(submission.criteriaSnapshot[0]!.title).toBe("Pass unit tests");
      expect(submission.criteriaSnapshot[1]!.title).toBe("Lint clean");

      // Verify criteriaHash matches exact RFC 8785 canonical hash of the snapshot
      const expectedHash = hashCanonicalJson(submission.criteriaSnapshot);
      expect(submission.criteriaHash).toBe(expectedHash);
      expect(submission.criteriaHash).toMatch(/^[0-9a-f]{64}$/);

      // Verify milestone automatically transitioned to SUBMITTED
      const updatedMilestone = await milestoneRepo.findById(milestone.id);
      expect(updatedMilestone!.status).toBe("SUBMITTED");
    });

    it("rejects submission if milestone has zero criteria", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "No Criteria Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Empty Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        // No criteria provided
      });

      // Manually set status to FUNDED
      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      await expect(
        submissionRepo.createSubmission({
          milestoneId: milestone.id,
          prNumber: 1,
          prCommitSha: "1111111111111111111111111111111111111111",
          prUrl: "https://github.com/acme/webapp/pull/1",
          submittedById: devId,
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects submission when milestone is not in a submittable state", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "State Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Draft Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        status: "DRAFT", // DRAFT cannot transition directly to SUBMITTED
        criteria: [
          {
            orderIndex: 1,
            title: "Test",
            description: "Desc",
            criterionType: "AUTOMATED_TEST",
          },
        ],
      });

      await expect(
        submissionRepo.createSubmission({
          milestoneId: milestone.id,
          prNumber: 1,
          prCommitSha: "1111111111111111111111111111111111111111",
          prUrl: "https://github.com/acme/webapp/pull/1",
          submittedById: devId,
        })
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it("enforces sequential submissionNumber and distinct commit SHA for CHANGES_REQUESTED resubmissions", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Resubmission Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Resubmit Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [
          {
            orderIndex: 1,
            title: "Test",
            description: "Desc",
            criterionType: "AUTOMATED_TEST",
          },
        ],
      });

      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      const sha1 = "1111111111111111111111111111111111111111";
      const sub1 = await submissionRepo.createSubmission({
        milestoneId: milestone.id,
        prNumber: 10,
        prCommitSha: sha1,
        prUrl: "https://github.com/acme/webapp/pull/10",
        submittedById: devId,
      });
      expect(sub1.submissionNumber).toBe(1);

      // Simulate policy rejection: milestone -> CHANGES_REQUESTED
      await milestoneRepo.updateStatus(milestone.id, "CHANGES_REQUESTED");

      // Attempt resubmission with identical SHA must be rejected per Slice 2.1 rule
      // (authoritative prior SHA is retrieved from DB, not from caller)
      await expect(
        submissionRepo.createSubmission({
          milestoneId: milestone.id,
          prNumber: 10,
          prCommitSha: sha1,
          prUrl: "https://github.com/acme/webapp/pull/10",
          submittedById: devId,
        })
      ).rejects.toThrow(DomainValidationError);

      // Resubmission with new SHA succeeds
      const sha2 = "2222222222222222222222222222222222222222";
      const sub2 = await submissionRepo.createSubmission({
        milestoneId: milestone.id,
        prNumber: 10,
        prCommitSha: sha2,
        prUrl: "https://github.com/acme/webapp/pull/10",
        submittedById: devId,
      });

      expect(sub2.submissionNumber).toBe(2);
      expect(sub2.prCommitSha).toBe(sha2);

      // Verify prior submission remains intact and sequential numbers increment
      const previous = await submissionRepo.findById(sub1.id);
      expect(previous!.submissionNumber).toBe(1);
      expect(previous!.prCommitSha).toBe(sha1);
      expect(sub2.submissionNumber).toBe(2);
      expect(sub2.prCommitSha).toBe(sha2);
    });

    it("verifies database immutability trigger blocks UPDATE and DELETE on MilestoneSubmission", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Immutability Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Immutable Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [
          {
            orderIndex: 1,
            title: "Test",
            description: "Desc",
            criterionType: "AUTOMATED_TEST",
          },
        ],
      });

      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      const submission = await submissionRepo.createSubmission({
        milestoneId: milestone.id,
        prNumber: 1,
        prCommitSha: "3333333333333333333333333333333333333333",
        prUrl: "https://github.com/acme/webapp/pull/1",
        submittedById: devId,
      });

      // Attempting direct raw SQL UPDATE on MilestoneSubmission triggers trg_submission_immutable (SQLSTATE 55000)
      let updateError: any;
      try {
        await pgClient.query(`UPDATE "MilestoneSubmission" SET "prUrl" = 'tampered' WHERE id = '${submission.id}';`);
      } catch (err: any) {
        updateError = err;
      }
      expect(updateError).toBeDefined();
      expect(updateError.code).toBe("55000");
      expect(updateError.message).toMatch(/SECURITY VIOLATION.*MilestoneSubmission records are strictly immutable/i);

      // Attempting direct raw SQL DELETE on MilestoneSubmission triggers trg_submission_immutable (SQLSTATE 55000)
      let deleteError: any;
      try {
        await pgClient.query(`DELETE FROM "MilestoneSubmission" WHERE id = '${submission.id}';`);
      } catch (err: any) {
        deleteError = err;
      }
      expect(deleteError).toBeDefined();
      expect(deleteError.code).toBe("55000");
      expect(deleteError.message).toMatch(/SECURITY VIOLATION.*MilestoneSubmission records are strictly immutable/i);
    });
  });

  // ==========================================================================
  // 4. Policy Evaluation Repository Tests
  // ==========================================================================
  describe("Policy Evaluation Repository", () => {
    async function setupSubmittedMilestone() {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Policy Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Policy Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [
          {
            orderIndex: 1,
            title: "Test Suite",
            description: "All pass",
            criterionType: "AUTOMATED_TEST",
            isMandatory: true,
          },
        ],
      });

      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      const submission = await submissionRepo.createSubmission({
        milestoneId: milestone.id,
        prNumber: 5,
        prCommitSha: "4444444444444444444444444444444444444444",
        prUrl: "https://github.com/acme/webapp/pull/5",
        submittedById: devId,
      });

      return { contract, milestone, submission, devId, clientId };
    }

    it("creates, updates, and completes a policy evaluation linked to submission", async () => {
      const { milestone, submission } = await setupSubmittedMilestone();

      // 1. Create in-progress evaluation
      const evalRecord = await policyRepo.createEvaluation({
        submissionId: submission.id,
        milestoneId: milestone.id,
        criteriaHash: submission.criteriaHash,
        policyVersion: "1.0.0",
      });

      expect(evalRecord.id).toMatch(/^peval_/);
      expect(evalRecord.status).toBe("IN_PROGRESS");
      expect(evalRecord.evaluationNumber).toBe(1);
      expect(evalRecord.decision).toBeNull();

      // 2. Update while IN_PROGRESS
      const updated = await policyRepo.updateEvaluation(evalRecord.id, {
        status: "IN_PROGRESS",
        evaluations: [
          {
            criterionId: submission.criteriaSnapshot[0]!.criterionId,
            criterionType: "AUTOMATED_TEST",
            passed: true,
            evidence: { testCount: 15, durationMs: 400 },
          },
        ],
      });
      expect(updated.status).toBe("IN_PROGRESS");

      // 3. Complete evaluation with PASS decision
      const completed = await policyRepo.updateEvaluation(evalRecord.id, {
        status: "COMPLETED",
        decision: "PASS",
        decisionReason: "100% mandatory criteria passed",
        evaluations: [
          {
            criterionId: submission.criteriaSnapshot[0]!.criterionId,
            criterionType: "AUTOMATED_TEST",
            passed: true,
            evidence: { testCount: 15, durationMs: 400 },
          },
        ],
        completedAt: new Date(),
      });

      expect(completed.status).toBe("COMPLETED");
      expect(completed.decision).toBe("PASS");
      expect(completed.completedAt).not.toBeNull();

      // 4. Verify immutable: further updates to completed evaluation are blocked
      await expect(
        policyRepo.updateEvaluation(evalRecord.id, {
          status: "FAILED",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects cross-milestone evaluation creation", async () => {
      const { milestone, submission, clientId, devId, contract } = await setupSubmittedMilestone();

      // Create a second milestone on the same contract
      const otherMilestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Other Milestone",
        description: "Desc",
        orderIndex: 2,
        amountMinorUnits: 300000n,
        currency: "USD",
        criteria: [{ orderIndex: 1, title: "Other", description: "D", criterionType: "SPECIFICATION" }],
      });

      // Attempt to link submission to otherMilestone (cross-milestone mismatch)
      await expect(
        policyRepo.createEvaluation({
          submissionId: submission.id,
          milestoneId: otherMilestone.id, // Mismatch!
          criteriaHash: submission.criteriaHash,
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects evaluation creation with mismatched criteriaHash", async () => {
      const { milestone, submission } = await setupSubmittedMilestone();

      const fakeHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      await expect(
        policyRepo.createEvaluation({
          submissionId: submission.id,
          milestoneId: milestone.id,
          criteriaHash: fakeHash, // Mismatch!
        })
      ).rejects.toThrow(DomainValidationError);
    });
  });

  // ==========================================================================
  // 5. Transaction Rollback & Concurrency Verification Tests
  // ==========================================================================
  describe("Transaction Rollback & Concurrency", () => {
    it("rolls back multi-step operation completely when an error occurs inside a transaction", async () => {
      const { clientId, devId } = await seedUsers();

      // Transaction attempts to create a contract and then deliberately throws an error
      await expect(
        prisma.$transaction(async (tx) => {
          await contractRepo.create(
            {
              id: "cnt_rollback_test",
              title: "Rollback Contract",
              description: "Desc",
              clientId,
              developerId: devId,
              totalAmountMinorUnits: 100000n,
              currency: "USD",
              githubRepoOwner: "acme",
              githubRepoName: "webapp",
            },
            { tx }
          );

          // Simulate subsequent failure in multi-step flow
          throw new Error("Deliberate failure to trigger rollback");
        })
      ).rejects.toThrow("Deliberate failure to trigger rollback");

      // Verify contract was rolled back and does not exist
      const retrieved = await contractRepo.findById("cnt_rollback_test");
      expect(retrieved).toBeNull();
    });

    it("serializes concurrent criteria amendments under milestone row lock", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Lock Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Concurrent Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [{ orderIndex: 1, title: "Base", description: "D", criterionType: "SPECIFICATION" }],
      });

      // Run two concurrent criteria amendments simultaneously
      const [res1, res2] = await Promise.all([
        milestoneRepo.amendCriteria(milestone.id, [
          { orderIndex: 1, title: "Amendment A", description: "D", criterionType: "AUTOMATED_TEST" },
        ]),
        milestoneRepo.amendCriteria(milestone.id, [
          { orderIndex: 1, title: "Amendment B", description: "D", criterionType: "CODE_QUALITY" },
        ]),
      ]);

      // Both should have succeeded sequentially under row locks, yielding versions 2 and 3
      const versions = [res1.activeCriteriaVersion, res2.activeCriteriaVersion].sort();
      expect(versions).toEqual([2, 3]);

      const finalMilestone = await milestoneRepo.findById(milestone.id);
      expect(finalMilestone!.activeCriteriaVersion).toBe(3);
    });

    it("serializes two simultaneous submissions for the same milestone: exactly one succeeds and one is rejected", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Race Submission Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Race Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 400000n,
        currency: "USD",
        criteria: [{ orderIndex: 1, title: "Base Criterion", description: "Desc", criterionType: "AUTOMATED_TEST" }],
      });

      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      const t1LockAcquired = createDeferred<void>();
      const t1ReleaseBarrier = createDeferred<void>();
      const t2PidCaptured = createDeferred<number>();
      let tx2Completed = false;

      // Transaction 1: acquires Milestone row lock, inserts submission, and holds transaction open.
      // In PostgreSQL READ COMMITTED, without the Milestone FOR UPDATE row lock, T2 could read the
      // last committed FUNDED state while T1's submission transaction is still uncommitted,
      // leading to concurrent submission attempts. With the lock, T2 blocks until T1 commits.
      const tx1Promise = prisma.$transaction(async (tx1) => {
        const sub = await submissionRepo.createSubmission(
          {
            milestoneId: milestone.id,
            prNumber: 101,
            prCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            prUrl: "https://github.com/acme/webapp/pull/101",
            submittedById: devId,
          },
          { tx: tx1 }
        );
        // Signal that Tx1 has acquired the Milestone FOR UPDATE lock and completed insertion
        t1LockAcquired.resolve();
        // Hold Tx1 open across barrier to ensure Tx2 contends on the row lock
        await t1ReleaseBarrier.promise;
        return sub;
      });

      // Transaction 2: independent connection attempts createSubmission on the same milestone
      const tx2Promise = prisma
        .$transaction(async (tx2) => {
          const pidRows = await tx2.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() as pid;`;
          t2PidCaptured.resolve(pidRows[0]!.pid);
          await t1LockAcquired.promise;

          return submissionRepo.createSubmission(
            {
              milestoneId: milestone.id,
              prNumber: 102,
              prCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              prUrl: "https://github.com/acme/webapp/pull/102",
              submittedById: devId,
            },
            { tx: tx2 }
          );
        })
        .finally(() => {
          tx2Completed = true;
        });

      try {
        // Bounded wait for Tx1 lock acquisition (fails fast if Tx1 encounters an error)
        await awaitSignal(t1LockAcquired, tx1Promise, 5000, "Tx1 lock acquisition");

        // Bounded wait for Tx2 PID capture (fails fast if Tx2 encounters an error)
        const t2Pid = await awaitSignal(t2PidCaptured, tx2Promise, 5000, "Tx2 PID capture");

        // Verify that T2's exact backend session is actively waiting on PostgreSQL row lock held by Tx1
        const lockStatus = await waitForPidLockWait(t2Pid, 2000);
        expect(lockStatus.isLocked).toBe(true);
        expect(lockStatus.waitEventType).toBe("Lock");
        expect(lockStatus.state).toBe("active");
        expect(tx2Completed).toBe(false);

        // Release Tx1 so it commits its update (milestone status -> SUBMITTED) and releases lock
        t1ReleaseBarrier.resolve();
        const tx1Result = await tx1Promise;
        expect(tx1Result.submissionNumber).toBe(1);

        // Tx2 unblocks, re-reads the locked milestone row (now SUBMITTED), and fails domain state transition
        await expect(tx2Promise).rejects.toThrow(InvalidStateTransitionError);

        // Verify exactly one submission record was persisted with sequence number 1
        const submissions = await submissionRepo.findByMilestoneId(milestone.id);
        expect(submissions.length).toBe(1);
        expect(submissions[0]!.submissionNumber).toBe(1);
        expect(submissions[0]!.prNumber).toBe(101);

        // Verify final milestone state transitioned to SUBMITTED
        const finalMilestone = await milestoneRepo.findById(milestone.id);
        expect(finalMilestone!.status).toBe("SUBMITTED");
      } finally {
        // Guarantee cleanup: unblock Tx1 if any assertion failed, and wait for both transactions to settle
        t1ReleaseBarrier.resolve();
        await Promise.allSettled([tx1Promise, tx2Promise]);
      }
    });

    it("serializes two simultaneous evaluation creations for the same submission numbering scope", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Race Evaluation Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Evaluation Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 300000n,
        currency: "USD",
        criteria: [{ orderIndex: 1, title: "Base Criterion", description: "Desc", criterionType: "AUTOMATED_TEST" }],
      });

      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      const submission = await submissionRepo.createSubmission({
        milestoneId: milestone.id,
        prNumber: 50,
        prCommitSha: "5050505050505050505050505050505050505050",
        prUrl: "https://github.com/acme/webapp/pull/50",
        submittedById: devId,
      });

      const t1LockAcquired = createDeferred<void>();
      const t1ReleaseBarrier = createDeferred<void>();
      const t2PidCaptured = createDeferred<number>();
      let tx2Completed = false;

      // Transaction 1: creates evaluation 1 under MilestoneSubmission FOR UPDATE lock and holds open.
      // In PostgreSQL READ COMMITTED, without the MilestoneSubmission FOR UPDATE row lock, T2 would
      // calculate the same next evaluation number because T1's inserted evaluation is not yet
      // committed; the unique constraint on (submissionId, evaluationNumber) can then reject the duplicate.
      // With the lock, T2 blocks until T1 commits, then correctly reads max evaluationNumber = 1 and assigns 2.
      const tx1Promise = prisma.$transaction(async (tx1) => {
        const ev = await policyRepo.createEvaluation(
          {
            submissionId: submission.id,
            milestoneId: milestone.id,
            criteriaHash: submission.criteriaHash,
            policyVersion: "1.0.0",
          },
          { tx: tx1 }
        );
        t1LockAcquired.resolve();
        await t1ReleaseBarrier.promise;
        return ev;
      });

      // Transaction 2: attempts to create evaluation concurrently on independent connection
      const tx2Promise = prisma
        .$transaction(async (tx2) => {
          const pidRows = await tx2.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() as pid;`;
          t2PidCaptured.resolve(pidRows[0]!.pid);
          await t1LockAcquired.promise;

          return policyRepo.createEvaluation(
            {
              submissionId: submission.id,
              milestoneId: milestone.id,
              criteriaHash: submission.criteriaHash,
              policyVersion: "1.0.0",
            },
            { tx: tx2 }
          );
        })
        .finally(() => {
          tx2Completed = true;
        });

      try {
        // Bounded wait for Tx1 lock acquisition (fails fast if Tx1 encounters an error)
        await awaitSignal(t1LockAcquired, tx1Promise, 5000, "Tx1 lock acquisition");

        // Bounded wait for Tx2 PID capture (fails fast if Tx2 encounters an error)
        const t2Pid = await awaitSignal(t2PidCaptured, tx2Promise, 5000, "Tx2 PID capture");

        // Verify that T2's exact session is blocked in PostgreSQL on the MilestoneSubmission row lock
        const lockStatus = await waitForPidLockWait(t2Pid, 2000);
        expect(lockStatus.isLocked).toBe(true);
        expect(lockStatus.waitEventType).toBe("Lock");
        expect(lockStatus.state).toBe("active");
        expect(tx2Completed).toBe(false);

        // Release Tx1 barrier so Tx1 commits evaluationNumber = 1
        t1ReleaseBarrier.resolve();
        const eval1 = await tx1Promise;
        const eval2 = await tx2Promise;

        expect(eval1.evaluationNumber).toBe(1);
        expect(eval2.evaluationNumber).toBe(2);

        // Verify exactly two evaluations are persisted
        const allEvals = await policyRepo.findBySubmissionId(submission.id);
        expect(allEvals.length).toBe(2);
        expect(allEvals[0]!.evaluationNumber).toBe(1);
        expect(allEvals[1]!.evaluationNumber).toBe(2);

        // Verify latest evaluation returns sequence number 2
        const latest = await policyRepo.findLatestBySubmissionId(submission.id);
        expect(latest).not.toBeNull();
        expect(latest!.evaluationNumber).toBe(2);
      } finally {
        // Guarantee cleanup: unblock Tx1 if any assertion failed, and wait for both transactions to settle
        t1ReleaseBarrier.resolve();
        await Promise.allSettled([tx1Promise, tx2Promise]);
      }
    });

    it("handles submission creation racing with criteria amendment under milestone row lock", async () => {
      const { clientId, devId } = await seedUsers();
      const contract = await contractRepo.create({
        title: "Racing Submission Amendment Contract",
        description: "Desc",
        clientId,
        developerId: devId,
        totalAmountMinorUnits: 1000000n,
        currency: "USD",
        githubRepoOwner: "acme",
        githubRepoName: "webapp",
      });

      const milestone = await milestoneRepo.create({
        contractId: contract.id,
        title: "Racing Milestone",
        description: "Desc",
        orderIndex: 1,
        amountMinorUnits: 500000n,
        currency: "USD",
        criteria: [
          { orderIndex: 1, title: "Initial Criteria v1 - Unit Tests", description: "Desc v1.1", criterionType: "AUTOMATED_TEST", isMandatory: true },
          { orderIndex: 2, title: "Initial Criteria v1 - Linting", description: "Desc v1.2", criterionType: "CODE_QUALITY", isMandatory: false },
        ],
      });

      await milestoneRepo.updateStatus(milestone.id, "FUNDED");

      const t1LockAcquired = createDeferred<void>();
      const t1ReleaseBarrier = createDeferred<void>();
      const t2PidCaptured = createDeferred<number>();
      let tx2Completed = false;

      // Transaction 1: amends criteria to v2 inside interactive transaction and holds Milestone row lock.
      // In PostgreSQL READ COMMITTED, without the Milestone FOR UPDATE row lock, T2 can read the
      // previously committed criteria version (v1) while T1's amendment is still uncommitted,
      // potentially creating a submission snapshot from the old version. With the lock, T2 blocks
      // until T1 commits, snapshotting the newly committed active criteria version (v2).
      const amendmentPromise = prisma.$transaction(async (tx1) => {
        const amendRes = await milestoneRepo.amendCriteria(
          milestone.id,
          [
            { orderIndex: 1, title: "Amended Criteria v2 - Spec", description: "Desc v2.1", criterionType: "SPECIFICATION", isMandatory: true },
            { orderIndex: 2, title: "Amended Criteria v2 - Integration", description: "Desc v2.2", criterionType: "AUTOMATED_TEST", isMandatory: true },
          ],
          { tx: tx1 }
        );
        t1LockAcquired.resolve();
        await t1ReleaseBarrier.promise;
        return amendRes;
      });

      // Transaction 2: developer attempts createSubmission concurrently
      const submissionPromise = prisma
        .$transaction(async (tx2) => {
          const pidRows = await tx2.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() as pid;`;
          t2PidCaptured.resolve(pidRows[0]!.pid);
          await t1LockAcquired.promise;

          return submissionRepo.createSubmission(
            {
              milestoneId: milestone.id,
              prNumber: 77,
              prCommitSha: "7777777777777777777777777777777777777777",
              prUrl: "https://github.com/acme/webapp/pull/77",
              submittedById: devId,
            },
            { tx: tx2 }
          );
        })
        .finally(() => {
          tx2Completed = true;
        });

      try {
        // Bounded wait for Tx1 criteria amendment lock acquisition (fails fast if Tx1 encounters an error)
        await awaitSignal(t1LockAcquired, amendmentPromise, 5000, "Tx1 criteria amendment lock acquisition");

        // Bounded wait for Tx2 submission PID capture (fails fast if Tx2 encounters an error)
        const t2Pid = await awaitSignal(t2PidCaptured, submissionPromise, 5000, "Tx2 submission PID capture");

        // Verify that createSubmission's exact session is BLOCKED waiting on PostgreSQL Milestone row lock
        const lockStatus = await waitForPidLockWait(t2Pid, 2000);
        expect(lockStatus.isLocked).toBe(true);
        expect(lockStatus.waitEventType).toBe("Lock");
        expect(lockStatus.state).toBe("active");
        expect(tx2Completed).toBe(false);

        // Release Tx1 barrier to commit criteria amendment (activeCriteriaVersion becomes 2)
        t1ReleaseBarrier.resolve();
        const amendmentResult = await amendmentPromise;
        const submissionResult = await submissionPromise;

        expect(amendmentResult.activeCriteriaVersion).toBe(2);
        expect(submissionResult.submissionNumber).toBe(1);
        expect(submissionResult.criteriaVersion).toBe(2);

        // 1. Read actual AcceptanceCriterion rows for the submission's recorded criteriaVersion
        const dbCriteriaRows = await prisma.acceptanceCriterion.findMany({
          where: {
            milestoneId: milestone.id,
            version: submissionResult.criteriaVersion,
          },
          orderBy: { orderIndex: "asc" },
        });

        expect(dbCriteriaRows.length).toBe(2);
        expect(submissionResult.criteriaSnapshot.length).toBe(dbCriteriaRows.length);

        // 2. Compare every snapshot field against those database rows
        for (let i = 0; i < dbCriteriaRows.length; i++) {
          const dbRow = dbCriteriaRows[i]!;
          const snap = submissionResult.criteriaSnapshot[i]!;

          expect(snap.criterionId).toBe(dbRow.id);
          expect(snap.orderIndex).toBe(dbRow.orderIndex);
          expect(snap.title).toBe(dbRow.title);
          expect(snap.description).toBe(dbRow.description);
          expect(snap.criterionType).toBe(dbRow.criterionType);
          expect(snap.isMandatory).toBe(dbRow.isMandatory);
        }

        // 3. Recompute and verify the canonical RFC 8785 hash
        const recomputedHash = hashCanonicalJson(submissionResult.criteriaSnapshot);
        expect(submissionResult.criteriaHash).toBe(recomputedHash);

        // Also verify persisted submission database record matches recomputed hash
        const persistedSub = await prisma.milestoneSubmission.findUnique({
          where: { id: submissionResult.id },
        });
        expect(persistedSub).not.toBeNull();
        expect(persistedSub!.criteriaHash).toBe(recomputedHash);
        expect(persistedSub!.criteriaVersion).toBe(2);

        // 4. Verify final activeCriteriaVersion and milestone state
        const finalMilestone = await milestoneRepo.findById(milestone.id);
        expect(finalMilestone!.activeCriteriaVersion).toBe(2);
        expect(finalMilestone!.status).toBe("SUBMITTED");
      } finally {
        // Guarantee cleanup: unblock Tx1 if any assertion failed, and wait for both transactions to settle
        t1ReleaseBarrier.resolve();
        await Promise.allSettled([amendmentPromise, submissionPromise]);
      }
    });
  });
});
