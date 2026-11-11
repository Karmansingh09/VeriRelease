/**
 * VeriRelease Full Hackathon End-to-End & Edge-Case Integration Suite
 *
 * Exercises the complete end-to-end contract -> milestone -> funding -> PR submission
 * -> GitHub evidence -> AI evaluation -> Deterministic Policy -> PayPal Sandbox payout
 * lifecycle and failure/edge-case matrix against live PostgreSQL 18.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import { prisma } from "../../src/lib/prisma";
import { contractService } from "../../src/modules/contracts";
import {
  aiEvaluationService,
  AiEvaluationService,
  OpenAiAiProvider,
} from "../../src/modules/ai";
import { PolicyEvaluationService } from "../../src/modules/policy";
import { GitHubEvidenceService, FetchGitHubProvider, PrismaEvidenceRepository } from "../../src/modules/github";
import {
  payoutCoordinator,
  PayoutCoordinator,
  PaymentCoordinatorService,
  PrismaPaymentRepository,
  PrismaReconciliationRepository,
  MockPayPalClient,
} from "../../src/modules/payments";
import { DefaultAuditService, PrismaAuditRepository } from "../../src/modules/audit";
import type { AuthenticatedUser } from "../../src/modules/auth/types";
import {
  ConcurrencyConflictError,
  DomainForbiddenError,
  DuplicatePayoutError,
} from "../../src/modules/common/errors";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("VeriRelease Complete End-to-End Hackathon Matrix (PostgreSQL)", () => {
  let pgClient: PoolClient;

  const clientUser: AuthenticatedUser = {
    id: "usr_e2e_client",
    email: "alice.e2e@verirelease.demo",
    name: "Alice Client",
    role: "CLIENT",
    githubUsername: "alice-e2e",
    isActive: true,
    tokenVersion: 1,
  };

  const devUser: AuthenticatedUser = {
    id: "usr_e2e_dev",
    email: "bob.e2e@verirelease.demo",
    name: "Bob Developer",
    role: "DEVELOPER",
    githubUsername: "bob-e2e",
    isActive: true,
    tokenVersion: 1,
  };

  const thirdPartyUser: AuthenticatedUser = {
    id: "usr_e2e_intruder",
    email: "eve.e2e@verirelease.demo",
    name: "Eve Outsider",
    role: "CLIENT",
    githubUsername: "eve-e2e",
    isActive: true,
    tokenVersion: 1,
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
      data: [
        {
          id: clientUser.id,
          email: clientUser.email,
          name: clientUser.name,
          role: clientUser.role,
          githubUsername: clientUser.githubUsername,
          isActive: true,
        },
        {
          id: devUser.id,
          email: devUser.email,
          name: devUser.name,
          role: devUser.role,
          githubUsername: devUser.githubUsername,
          paypalReceiverEmail: "sb-bob@business.example.com",
          isActive: true,
        },
        {
          id: thirdPartyUser.id,
          email: thirdPartyUser.email,
          name: thirdPartyUser.name,
          role: thirdPartyUser.role,
          githubUsername: thirdPartyUser.githubUsername,
          isActive: true,
        },
      ],
    });
  });

  async function seedEvidenceSnapshot(params: {
    submissionId: string;
    milestoneId: string;
    prNumber: number;
    checksStatus: "SUCCESS" | "FAILURE" | "UNAVAILABLE";
    commitCount?: number;
  }) {
    await prisma.gitHubEvidenceSnapshot.create({
      data: {
        id: `ev_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        submissionId: params.submissionId,
        milestoneId: params.milestoneId,
        snapshotVersion: 1,
        repositoryId: 888999n,
        repoOwner: "Karmansingh09",
        repoName: "VeriRelease",
        prNumber: params.prNumber,
        prUrl: `https://github.com/Karmansingh09/VeriRelease/pull/${params.prNumber}`,
        prTitle: `feat: implement milestone PR #${params.prNumber}`,
        prBody: "Implements complete payout verification module with integration tests.",
        prAuthor: "bob-e2e",
        prState: "open",
        headBranch: "feat/milestone",
        headCommitSha: "a1b2c3d4e5f678901234567890abcdef12345678",
        baseBranch: "main",
        baseCommitSha: "0000000000000000000000000000000000000000",
        commitCount: params.commitCount ?? 2,
        commits: [{ sha: "a1b2c3d4e5f678901234567890abcdef12345678", message: "feat: done" }],
        checks:
          params.checksStatus === "UNAVAILABLE"
            ? []
            : [
                {
                  name: "ci/vitest",
                  status: "completed",
                  conclusion: params.checksStatus === "SUCCESS" ? "success" : "failure",
                },
              ],
        checksStatus: params.checksStatus,
        evidenceHash: "e".repeat(64),
      },
    });
  }

  async function createContractAndFundedMilestone() {
    const contract = await contractService.createContract(clientUser.id, {
      title: "VeriRelease E2E Audit Contract",
      description: "Full hackathon integration contract verification",
      developerId: devUser.id,
      totalAmountUsd: 1000,
      currency: "USD",
      githubRepoOwner: "Karmansingh09",
      githubRepoName: "VeriRelease",
    });

    const milestone = await contractService.addMilestone(contract.id, clientUser.id, {
      title: "Milestone 1: Verification & Settlement",
      description: "Deliver API routes and passing CI",
      amountUsd: 500,
      criteria: [
        {
          title: "Automated CI Tests",
          description: "CI test runs pass",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
        {
          title: "Deliverable File Changes",
          description: "PR contains verified changes",
          criterionType: "FILE_CHANGE",
          isMandatory: true,
        },
      ],
    });

    await contractService.fundMilestone(milestone.id, clientUser.id);
    return { contract, milestone };
  }

  it("1. Happy Path: Create -> Fund -> Submit PR -> Evidence -> AI + Policy PASS -> PayPal SUCCEEDED", async () => {
    const { milestone } = await createContractAndFundedMilestone();

    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 101,
      prCommitSha: "a1b2c3d4e5f678901234567890abcdef12345678",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/101",
    });

    await seedEvidenceSnapshot({
      submissionId: submission.id,
      milestoneId: milestone.id,
      prNumber: 101,
      checksStatus: "SUCCESS",
    });

    const outcome = await aiEvaluationService.evaluateSubmission(submission.id, clientUser);
    expect(outcome.decision).toBe("PASS");
    expect(outcome.milestoneStatus).toBe("ELIGIBLE_FOR_PAYOUT");
    expect(outcome.receiptHash).toHaveLength(64);

    const payout = await payoutCoordinator.executePayout({
      milestoneId: milestone.id,
      callerId: clientUser.id,
    });

    expect(payout.transaction.status).toBe("SUCCEEDED");
    expect(payout.transaction.amountMinorUnits).toBe(50000n);
    expect(payout.paypalOrderId).toBeTruthy();
    expect(payout.paypalCaptureId).toBeTruthy();

    // Verify full audit timeline persisted
    const details = await contractService.getMilestoneDetails(milestone.id, clientUser.id);
    const actions = details.auditTimeline.map((a) => a.action);
    expect(actions).toContain("MILESTONE_CREATED");
    expect(actions).toContain("MILESTONE_FUNDED");
    expect(actions).toContain("MILESTONE_SUBMITTED");
    expect(actions).toContain("POLICY_EVALUATION_APPROVED");
  });

  it("2. Missing/Unavailable CI Evidence: Policy returns FAIL (CHANGES_REQUESTED) and blocks payout", async () => {
    const { milestone } = await createContractAndFundedMilestone();

    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 102,
      prCommitSha: "a1b2c3d4e5f678901234567890abcdef12345678",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/102",
    });

    await seedEvidenceSnapshot({
      submissionId: submission.id,
      milestoneId: milestone.id,
      prNumber: 102,
      checksStatus: "UNAVAILABLE",
    });

    const outcome = await aiEvaluationService.evaluateSubmission(submission.id, clientUser);
    expect(outcome.decision).toBe("FAIL");
    expect(outcome.milestoneStatus).toBe("CHANGES_REQUESTED");
    expect(outcome.aiEvaluation.missingEvidence.length + outcome.aiEvaluation.risks.length).toBeGreaterThan(0);

    await expect(
      payoutCoordinator.executePayout({
        milestoneId: milestone.id,
        callerId: clientUser.id,
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  it("3. Failed CI Checks: Policy returns FAIL (CHANGES_REQUESTED)", async () => {
    const { milestone } = await createContractAndFundedMilestone();

    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 103,
      prCommitSha: "a1b2c3d4e5f678901234567890abcdef12345678",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/103",
    });

    await seedEvidenceSnapshot({
      submissionId: submission.id,
      milestoneId: milestone.id,
      prNumber: 103,
      checksStatus: "FAILURE",
    });

    const outcome = await aiEvaluationService.evaluateSubmission(submission.id, clientUser);
    expect(outcome.decision).toBe("FAIL");
    expect(outcome.milestoneStatus).toBe("CHANGES_REQUESTED");
  });

  it("4. OpenAI Placeholder/Failure Falls Back Gracefully to Honest DemoAiProvider", async () => {
    const { milestone } = await createContractAndFundedMilestone();

    const submission = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 104,
      prCommitSha: "a1b2c3d4e5f678901234567890abcdef12345678",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/104",
    });

    await seedEvidenceSnapshot({
      submissionId: submission.id,
      milestoneId: milestone.id,
      prNumber: 104,
      checksStatus: "UNAVAILABLE",
    });

    const auditService = new DefaultAuditService(new PrismaAuditRepository(prisma), prisma);
    const policyService = new PolicyEvaluationService(undefined, undefined, undefined, auditService, prisma);
    const evidenceService = new GitHubEvidenceService(
      new FetchGitHubProvider({ baseUrl: "https://api.github.com" }),
      new PrismaEvidenceRepository(prisma),
      auditService,
      prisma
    );
    const openAiWithFallback = new OpenAiAiProvider({
      apiKey: "sk-mock-fallback-test",
      model: "gpt-4o-2024-08-06",
    });
    const service = new AiEvaluationService(
      openAiWithFallback,
      policyService,
      evidenceService,
      auditService,
      prisma
    );

    const outcome = await service.evaluateSubmission(submission.id, clientUser);
    expect(outcome.aiEvaluation.isDemoMode).toBe(true);
    // Must still refuse to fabricate passing CI checks when UNAVAILABLE
    expect(outcome.decision).toBe("FAIL");
  });

  it("5. Changes Requested & Developer Resubmission Loop Transitions Cleanly to Payout", async () => {
    const { milestone } = await createContractAndFundedMilestone();

    const sub1 = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 201,
      prCommitSha: "1111111111111111111111111111111111111111",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/201",
    });
    expect(sub1.submissionNumber).toBe(1);

    await contractService.requestChanges(
      milestone.id,
      clientUser.id,
      "Please add unit test coverage for edge cases"
    );

    const afterReq = await contractService.getMilestoneDetails(milestone.id, clientUser.id);
    expect(afterReq.status).toBe("CHANGES_REQUESTED");

    const sub2 = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 202,
      prCommitSha: "2222222222222222222222222222222222222222",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/202",
    });
    expect(sub2.submissionNumber).toBe(2);

    await seedEvidenceSnapshot({
      submissionId: sub2.id,
      milestoneId: milestone.id,
      prNumber: 202,
      checksStatus: "SUCCESS",
    });

    const outcome = await aiEvaluationService.evaluateSubmission(sub2.id, clientUser);
    expect(outcome.decision).toBe("PASS");
    expect(outcome.milestoneStatus).toBe("ELIGIBLE_FOR_PAYOUT");
  });

  it("6. Unauthorized Access Enforcement Across Client, Developer, and Outsider Boundaries", async () => {
    const { contract, milestone } = await createContractAndFundedMilestone();

    // Outsider cannot read contract or milestone
    await expect(contractService.getContractById(contract.id, thirdPartyUser.id)).rejects.toThrow(
      DomainForbiddenError
    );
    await expect(
      contractService.getMilestoneDetails(milestone.id, thirdPartyUser.id)
    ).rejects.toThrow(DomainForbiddenError);

    // Client cannot submit deliverable as developer
    await expect(
      contractService.submitMilestoneWork(milestone.id, clientUser.id, {
        prNumber: 301,
        prCommitSha: "3333333333333333333333333333333333333333",
        prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/301",
      })
    ).rejects.toThrow(DomainForbiddenError);

    // Developer submits PR, then tries to request changes or trigger payout -> Forbidden
    const sub = await contractService.submitMilestoneWork(milestone.id, devUser.id, {
      prNumber: 302,
      prCommitSha: "3333333333333333333333333333333333333333",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/302",
    });
    await seedEvidenceSnapshot({
      submissionId: sub.id,
      milestoneId: milestone.id,
      prNumber: 302,
      checksStatus: "SUCCESS",
    });
    await expect(
      contractService.requestChanges(milestone.id, devUser.id, "Self-reject attempt")
    ).rejects.toThrow(DomainForbiddenError);

    await aiEvaluationService.evaluateSubmission(sub.id, clientUser);
    await expect(
      payoutCoordinator.executePayout({
        milestoneId: milestone.id,
        callerId: devUser.id,
      })
    ).rejects.toThrow(DomainForbiddenError);
  });

  it("7. Duplicate Payout Prevention + Provider Timeout -> PAYOUT_UNCERTAIN Without Blind Retry", async () => {
    // Subcase A: Duplicate payout blocked
    const { milestone: m1 } = await createContractAndFundedMilestone();
    const s1 = await contractService.submitMilestoneWork(m1.id, devUser.id, {
      prNumber: 401,
      prCommitSha: "4444444444444444444444444444444444444444",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/401",
    });
    await seedEvidenceSnapshot({
      submissionId: s1.id,
      milestoneId: m1.id,
      prNumber: 401,
      checksStatus: "SUCCESS",
    });
    await aiEvaluationService.evaluateSubmission(s1.id, clientUser);

    const first = await payoutCoordinator.executePayout({
      milestoneId: m1.id,
      callerId: clientUser.id,
    });
    expect(first.transaction.status).toBe("SUCCEEDED");

    await expect(
      payoutCoordinator.executePayout({
        milestoneId: m1.id,
        callerId: clientUser.id,
      })
    ).rejects.toThrow(DuplicatePayoutError);

    // Subcase B: Provider timeout -> PAYOUT_UNCERTAIN without blind retry
    const { milestone: m2 } = await createContractAndFundedMilestone();
    const s2 = await contractService.submitMilestoneWork(m2.id, devUser.id, {
      prNumber: 402,
      prCommitSha: "5555555555555555555555555555555555555555",
      prUrl: "https://github.com/Karmansingh09/VeriRelease/pull/402",
    });
    await seedEvidenceSnapshot({
      submissionId: s2.id,
      milestoneId: m2.id,
      prNumber: 402,
      checksStatus: "SUCCESS",
    });
    await aiEvaluationService.evaluateSubmission(s2.id, clientUser);

    const auditService = new DefaultAuditService(new PrismaAuditRepository(prisma), prisma);
    const paymentService = new PaymentCoordinatorService(
      new PrismaPaymentRepository(prisma),
      auditService,
      prisma,
      new PrismaReconciliationRepository(prisma)
    );
    const timeoutCoordinator = new PayoutCoordinator(
      paymentService,
      new MockPayPalClient({ simulateAmbiguousTimeout: true }),
      auditService,
      prisma
    );

    const uncertain = await timeoutCoordinator.executePayout({
      milestoneId: m2.id,
      callerId: clientUser.id,
    });
    expect(uncertain.transaction.status).toBe("PAYOUT_UNCERTAIN");
    expect(uncertain.providerStatus).toBe("UNCERTAIN");
  });
});
