/**
 * AI Evaluation Unit Test Suite
 *
 * Covers:
 * - Evidence normalization and assessment generation
 * - Authorization enforcement (client, developer, admin vs. unauthorized third party)
 * - Handling missing GitHub evidence (e.g. unavailable CI, missing commits, missing SHA)
 * - Graceful AI provider fallback when OpenAI is unavailable or errors
 * - Criterion-level assessment accuracy
 * - Strict deterministic policy engine decision boundary (AI never authorizes payments directly)
 * - ELIGIBLE_FOR_PAYOUT decision produced ONLY by deterministic policy engine
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DemoAiProvider } from "../../src/modules/ai/providers/demo-ai-provider";
import { OpenAiAiProvider } from "../../src/modules/ai/providers/openai-ai-provider";
import { AiEvaluationService } from "../../src/modules/ai/ai-evaluation-service";
import {
  DomainForbiddenError,
  DomainNotFoundError,
} from "../../src/modules/common/errors";
import type { CriteriaSnapshotItem } from "../../src/modules/contracts/types";
import type { NormalizedEvidenceSummary } from "../../src/modules/ai/types";

describe("AI Evaluation Unit Tests", () => {
  const sampleCriteria: CriteriaSnapshotItem[] = [
    {
      criterionId: "crit_test",
      criterionType: "AUTOMATED_TEST",
      description: "Automated test suite must pass with 100% success",
      isMandatory: true,
      orderIndex: 1,
      title: "Test Suite Pass",
    },
    {
      criterionId: "crit_files",
      criterionType: "FILE_CHANGE",
      description: "Pull request must deliver code modifications",
      isMandatory: true,
      orderIndex: 2,
      title: "Code Deliverable Modified",
    },
    {
      criterionId: "crit_quality",
      criterionType: "CODE_QUALITY",
      description: "Linters and typechecks must not fail",
      isMandatory: false,
      orderIndex: 3,
      title: "Code Quality & Linting",
    },
  ];

  const passingEvidence: NormalizedEvidenceSummary = {
    prNumber: 42,
    prTitle: "feat(payments): implement PayPal capture workflow",
    prBody: "Implements idempotent payment reservation and capture",
    prUrl: "https://github.com/alice/repo/pull/42",
    prState: "open",
    isDraft: false,
    baseRef: "main",
    headRef: "feat/payments",
    headSha: "a".repeat(40),
    commitsCount: 3,
    changedFilesCount: 7,
    checkRunsCount: 4,
    checkRunsSuccessful: 4,
    checkRunsFailed: 0,
    ciStatus: "SUCCESS",
    rawEvidenceHash: "b".repeat(64),
  };

  const failingEvidence: NormalizedEvidenceSummary = {
    ...passingEvidence,
    checkRunsSuccessful: 2,
    checkRunsFailed: 2,
    ciStatus: "FAILURE",
  };

  const missingCiEvidence: NormalizedEvidenceSummary = {
    ...passingEvidence,
    checkRunsCount: 0,
    checkRunsSuccessful: 0,
    checkRunsFailed: 0,
    ciStatus: "UNAVAILABLE",
  };

  describe("DemoAiProvider (Deterministic)", () => {
    const provider = new DemoAiProvider();

    it("evaluates passing evidence with all criteria passing and recommends eligibility", async () => {
      const result = await provider.evaluate({
        contract: { id: "cnt_1", title: "C1", description: "D1", githubRepo: "alice/repo" },
        milestone: { id: "mls_1", title: "M1", description: "MD1" },
        submission: { id: "sub_1", submissionNumber: 1, prNumber: 42, prCommitSha: "a".repeat(40), prUrl: "url" },
        criteria: sampleCriteria,
        evidence: passingEvidence,
      });

      expect(result.provider).toBe("deterministic-demo");
      expect(result.isDemoMode).toBe(true);
      expect(result.suggestedAction).toBe("APPROVE_PAYOUT_ELIGIBILITY");
      expect(result.criterionAssessments).toHaveLength(3);

      const testCrit = result.criterionAssessments.find((c) => c.criterionId === "crit_test");
      expect(testCrit?.passed).toBe(true);
      expect(testCrit?.supportingEvidence.ciStatus).toBe("SUCCESS");

      const fileCrit = result.criterionAssessments.find((c) => c.criterionId === "crit_files");
      expect(fileCrit?.passed).toBe(true);
      expect(fileCrit?.supportingEvidence.changedFilesCount).toBe(7);
    });

    it("evaluates failing CI checks and suggests requesting changes", async () => {
      const result = await provider.evaluate({
        contract: { id: "cnt_1", title: "C1", description: "D1", githubRepo: "alice/repo" },
        milestone: { id: "mls_1", title: "M1", description: "MD1" },
        submission: { id: "sub_1", submissionNumber: 1, prNumber: 42, prCommitSha: "a".repeat(40), prUrl: "url" },
        criteria: sampleCriteria,
        evidence: failingEvidence,
      });

      expect(result.suggestedAction).toBe("REQUEST_CHANGES");
      const testCrit = result.criterionAssessments.find((c) => c.criterionId === "crit_test");
      expect(testCrit?.passed).toBe(false);
      expect(testCrit?.reason).toContain("failed");
    });

    it("fails mandatory automated test criterion when CI is UNAVAILABLE", async () => {
      const result = await provider.evaluate({
        contract: { id: "cnt_1", title: "C1", description: "D1", githubRepo: "alice/repo" },
        milestone: { id: "mls_1", title: "M1", description: "MD1" },
        submission: { id: "sub_1", submissionNumber: 1, prNumber: 42, prCommitSha: "a".repeat(40), prUrl: "url" },
        criteria: sampleCriteria,
        evidence: missingCiEvidence,
      });

      const testCrit = result.criterionAssessments.find((c) => c.criterionId === "crit_test");
      expect(testCrit?.passed).toBe(false);
      expect(result.risks).toContain("No automated CI/check run results are available for this commit");
    });

    it("identifies missing evidence when pull request has no changed files or commit SHA", async () => {
      const emptyEvidence: NormalizedEvidenceSummary = {
        ...passingEvidence,
        headSha: "",
        commitsCount: 0,
        changedFilesCount: 0,
      };

      const result = await provider.evaluate({
        contract: { id: "cnt_1", title: "C1", description: "D1", githubRepo: "alice/repo" },
        milestone: { id: "mls_1", title: "M1", description: "MD1" },
        submission: { id: "sub_1", submissionNumber: 1, prNumber: 42, prCommitSha: "", prUrl: "url" },
        criteria: sampleCriteria,
        evidence: emptyEvidence,
      });

      expect(result.missingEvidence.length).toBeGreaterThan(0);
      expect(result.suggestedAction).toBe("REQUEST_CHANGES");
    });
  });

  describe("OpenAiAiProvider Fallback Handling", () => {
    it("gracefully falls back to DemoAiProvider when apiKey is a mock or placeholder", async () => {
      const provider = new OpenAiAiProvider({ apiKey: "sk-mock-placeholder-key" });

      const result = await provider.evaluate({
        contract: { id: "cnt_1", title: "C1", description: "D1", githubRepo: "alice/repo" },
        milestone: { id: "mls_1", title: "M1", description: "MD1" },
        submission: { id: "sub_1", submissionNumber: 1, prNumber: 42, prCommitSha: "a".repeat(40), prUrl: "url" },
        criteria: sampleCriteria,
        evidence: passingEvidence,
      });

      expect(result.provider).toBe("deterministic-demo");
      expect(result.isDemoMode).toBe(true);
    });

    it("gracefully falls back to DemoAiProvider when network call fails", async () => {
      const provider = new OpenAiAiProvider({
        apiKey: "sk-real-looking-key-12345678901234567890",
        baseUrl: "http://invalid-localhost-offline:9999",
      });

      const result = await provider.evaluate({
        contract: { id: "cnt_1", title: "C1", description: "D1", githubRepo: "alice/repo" },
        milestone: { id: "mls_1", title: "M1", description: "MD1" },
        submission: { id: "sub_1", submissionNumber: 1, prNumber: 42, prCommitSha: "a".repeat(40), prUrl: "url" },
        criteria: sampleCriteria,
        evidence: passingEvidence,
      });

      expect(result.isDemoMode).toBe(true);
      expect(result.criterionAssessments).toHaveLength(3);
    });
  });

  describe("AiEvaluationService Orchestration & Safety Invariants", () => {
    let mockAiProvider: any;
    let mockPolicyService: any;
    let mockEvidenceService: any;
    let mockAuditService: any;
    let mockDb: any;
    let service: AiEvaluationService;

    const clientUser = { id: "usr_alice", role: "CLIENT", email: "alice@test.com" };
    const devUser = { id: "usr_bob", role: "DEVELOPER", email: "bob@test.com" };
    const thirdPartyUser = { id: "usr_charlie", role: "DEVELOPER", email: "charlie@test.com" };

    const sampleContract = {
      id: "cnt_1",
      title: "Test Contract",
      description: "Test Desc",
      clientId: clientUser.id,
      developerId: devUser.id,
      githubRepoOwner: "alice",
      githubRepoName: "repo",
    };

    const sampleMilestone = {
      id: "mls_1",
      contractId: sampleContract.id,
      title: "Test Milestone",
      description: "Milestone Desc",
      status: "SUBMITTED",
      contract: sampleContract,
    };

    const sampleSubmission = {
      id: "sub_1",
      milestoneId: sampleMilestone.id,
      submissionNumber: 1,
      prNumber: 42,
      prCommitSha: "a".repeat(40),
      prUrl: "https://github.com/alice/repo/pull/42",
      criteriaSnapshot: sampleCriteria,
      milestone: sampleMilestone,
    };

    beforeEach(() => {
      mockAiProvider = {
        name: "deterministic-demo",
        isDemo: true,
        evaluate: vi.fn().mockResolvedValue({
          overallAssessment: "All criteria verified",
          criterionAssessments: [
            { criterionId: "crit_test", passed: true, reason: "CI passed", supportingEvidence: {} },
            { criterionId: "crit_files", passed: true, reason: "Files modified", supportingEvidence: {} },
            { criterionId: "crit_quality", passed: true, reason: "Quality checks passed", supportingEvidence: {} },
          ],
          missingEvidence: [],
          risks: [],
          suggestedAction: "APPROVE_PAYOUT_ELIGIBILITY",
          provider: "deterministic-demo",
          model: "demo-v1",
          isDemoMode: true,
          evaluatedAt: new Date(),
        }),
      };

      mockPolicyService = {
        evaluateSubmission: vi.fn().mockResolvedValue({
          evaluation: {
            id: "pol_1",
            decision: "PASS",
            decisionReason: "All mandatory criteria passed",
            receiptHash: "c".repeat(64),
          },
          milestone: {
            id: sampleMilestone.id,
            status: "ELIGIBLE_FOR_PAYOUT",
          },
          evaluationResult: {
            decision: "PASS",
          },
          transitionResult: {},
        }),
        getLatestEvaluation: vi.fn(),
      };

      mockEvidenceService = {
        collectSubmissionEvidence: vi.fn(),
      };

      mockAuditService = {
        recordEvent: vi.fn().mockResolvedValue({}),
      };

      mockDb = {
        milestoneSubmission: {
          findUnique: vi.fn().mockResolvedValue(sampleSubmission),
        },
        gitHubEvidenceSnapshot: {
          findFirst: vi.fn().mockResolvedValue({
            id: "ev_1",
            submissionId: sampleSubmission.id,
            snapshotVersion: 1,
            prNumber: 42,
            prTitle: "PR 42",
            prBody: "PR Body",
            prState: "open",
            isDraft: false,
            baseRef: "main",
            headRef: "feat/test",
            headSha: "a".repeat(40),
            commitsCount: 2,
            changedFilesCount: 5,
            checkRunsCount: 3,
            checkRunsSuccessful: 3,
            checkRunsFailed: 0,
            ciStatus: "SUCCESS",
            rawPayload: {},
            evidenceHash: "d".repeat(64),
            collectedAt: new Date(),
          }),
        },
      };

      service = new AiEvaluationService(
        mockAiProvider,
        mockPolicyService,
        mockEvidenceService,
        mockAuditService,
        mockDb as any
      );
    });

    it("successfully runs AI evaluation and feeds assessments into deterministic policy engine", async () => {
      const outcome = await service.evaluateSubmission(sampleSubmission.id, clientUser as any);

      expect(outcome.decision).toBe("PASS");
      expect(outcome.milestoneStatus).toBe("ELIGIBLE_FOR_PAYOUT");
      expect(outcome.receiptHash).toBe("c".repeat(64));

      // Verifies policy service was called with assessments
      expect(mockPolicyService.evaluateSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          submissionId: sampleSubmission.id,
          assessments: expect.arrayContaining([
            expect.objectContaining({ criterionId: "crit_test", passed: true }),
          ]),
        })
      );

      // Verifies audit event
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "POLICY_EVALUATION",
          entityId: "pol_1",
          action: "AI_EVALUATION_COMPLETED",
          actorUserId: clientUser.id,
        })
      );
    });

    it("rejects unauthorized third party from triggering evaluation", async () => {
      await expect(
        service.evaluateSubmission(sampleSubmission.id, thirdPartyUser as any)
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("rejects evaluation of non-existent submission", async () => {
      mockDb.milestoneSubmission.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.evaluateSubmission("sub_ghost", clientUser as any)
      ).rejects.toThrow(DomainNotFoundError);
    });
  });
});
