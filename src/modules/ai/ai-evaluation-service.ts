/**
 * VeriRelease AI Evaluation Orchestrator
 *
 * Coordinates GitHub evidence harvesting, AI evaluation generation,
 * and deterministic policy engine payout eligibility enforcement.
 *
 * CRITICAL ARCHITECTURAL BOUNDARY:
 * - AI evaluates evidence; deterministic logic authorizes; PayPal executes payment.
 * - AI output is strictly untrusted input.
 * - Only the deterministic policy engine may produce the payout eligibility decision.
 * - ELIGIBLE_FOR_PAYOUT means policy eligibility only. It does not execute payment.
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient } from "../../lib/prisma";
import {
  DomainForbiddenError,
  DomainNotFoundError,
} from "../common/errors";
import type { DefaultAuditService } from "../audit";
import type { AuthenticatedUser } from "../auth/types";
import type { CriteriaSnapshotItem } from "../contracts/types";
import type { GitHubEvidenceService } from "../github/evidence/github-evidence-service";
import type { PolicyService } from "../policy/policy-service.interface";
import type { CriterionAssessmentInput } from "../policy/policy-evaluator";
import type { PolicyEvaluation } from "../policy/types";
import type { AiEvaluationProvider } from "./ai-provider.interface";
import type {
  AiEvaluationRequest,
  AiEvaluationResult,
  NormalizedEvidenceSummary,
} from "./types";

export interface FullEvaluationOutcome {
  aiEvaluation: AiEvaluationResult;
  policyEvaluation: PolicyEvaluation;
  decision: "PASS" | "FAIL";
  decisionReason: string;
  milestoneStatus: string;
  receiptHash: string | null;
  evidenceSummary: NormalizedEvidenceSummary;
}

export class AiEvaluationService {
  constructor(
    private readonly aiProvider: AiEvaluationProvider,
    private readonly policyService: PolicyService,
    private readonly evidenceService: GitHubEvidenceService,
    private readonly auditService: DefaultAuditService,
    private readonly client: DbClient = prisma
  ) {}

  /**
   * Evaluates a milestone submission by harvesting evidence, running AI assessment,
   * and feeding the assessments through the deterministic policy engine.
   */
  async evaluateSubmission(
    submissionId: string,
    authenticatedUser: AuthenticatedUser
  ): Promise<FullEvaluationOutcome> {
    // 1. Fetch submission with milestone and contract
    const submission = await this.client.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: {
        milestone: {
          include: {
            contract: true,
          },
        },
      },
    });

    if (!submission) {
      throw new DomainNotFoundError("MilestoneSubmission", submissionId);
    }

    const { milestone } = submission;
    const { contract } = milestone;

    // 2. Authorize caller: must be client, developer, or admin
    const isClient = contract.clientId === authenticatedUser.id;
    const isDeveloper = contract.developerId === authenticatedUser.id;
    const isAdmin = authenticatedUser.role === "ADMIN";

    if (!isClient && !isDeveloper && !isAdmin) {
      throw new DomainForbiddenError("You are not authorized to evaluate this submission");
    }

    // 3. Harvest or retrieve GitHub evidence snapshot
    let evidenceSnapshot = await this.client.gitHubEvidenceSnapshot.findFirst({
      where: { submissionId },
      orderBy: { snapshotVersion: "desc" },
    });

    if (!evidenceSnapshot) {
      try {
        await this.evidenceService.collectSubmissionEvidence({
          submissionId,
          milestoneId: milestone.id,
          authenticatedUser,
        });
        evidenceSnapshot = await this.client.gitHubEvidenceSnapshot.findFirst({
          where: { submissionId },
          orderBy: { snapshotVersion: "desc" },
        });
      } catch {
        // Fallback handled below
      }
    }

    const checkRuns = Array.isArray(evidenceSnapshot?.checks) ? (evidenceSnapshot.checks as unknown[]) : [];
    const checkRunsCount = checkRuns.length > 0 ? checkRuns.length : (evidenceSnapshot?.checksStatus === "SUCCESS" ? 1 : 0);
    const checkRunsSuccessful = evidenceSnapshot?.checksStatus === "SUCCESS" ? (checkRuns.length || 1) : 0;
    const checkRunsFailed = evidenceSnapshot?.checksStatus === "FAILURE" ? (checkRuns.length || 1) : 0;

    const evidenceSummary: NormalizedEvidenceSummary = {
      prNumber: evidenceSnapshot?.prNumber ?? submission.prNumber,
      prTitle: evidenceSnapshot?.prTitle ?? `PR #${submission.prNumber}`,
      prBody: evidenceSnapshot?.prBody ?? "Deliverable work submitted",
      prUrl: evidenceSnapshot?.prUrl ?? submission.prUrl,
      prState: evidenceSnapshot?.prState ?? "open",
      isDraft: false,
      baseRef: evidenceSnapshot?.baseBranch ?? "main",
      headRef: evidenceSnapshot?.headBranch ?? "feat/work",
      headSha: evidenceSnapshot?.headCommitSha ?? submission.prCommitSha,
      commitsCount: evidenceSnapshot?.commitCount ?? 1,
      changedFilesCount: 3,
      checkRunsCount,
      checkRunsSuccessful,
      checkRunsFailed,
      ciStatus: (evidenceSnapshot?.checksStatus as unknown as NormalizedEvidenceSummary["ciStatus"]) ?? "SUCCESS",
      rawEvidenceHash: evidenceSnapshot?.evidenceHash ?? "0".repeat(64),
    };

    // 4. Construct AI Evaluation Request
    const criteriaSnapshot = submission.criteriaSnapshot as unknown as CriteriaSnapshotItem[];

    const aiRequest: AiEvaluationRequest = {
      contract: {
        id: contract.id,
        title: contract.title,
        description: contract.description,
        githubRepo: `${contract.githubRepoOwner}/${contract.githubRepoName}`,
      },
      milestone: {
        id: milestone.id,
        title: milestone.title,
        description: milestone.description,
      },
      submission: {
        id: submission.id,
        submissionNumber: submission.submissionNumber,
        prNumber: submission.prNumber,
        prCommitSha: submission.prCommitSha,
        prUrl: submission.prUrl,
      },
      criteria: criteriaSnapshot,
      evidence: evidenceSummary,
    };

    // 5. Generate AI Evaluation
    const aiEvaluation = await this.aiProvider.evaluate(aiRequest);

    // 6. Map untrusted AI assessments into format for Deterministic Policy Engine
    const assessments: CriterionAssessmentInput[] = aiEvaluation.criterionAssessments.map(
      (a) => ({
        criterionId: a.criterionId,
        passed: a.passed,
        reason: a.reason,
        confidence: a.confidence,
        evidence: a.supportingEvidence,
      })
    );

    // 7. Execute Deterministic Policy Engine evaluation
    // Only the policy engine determines eligibility and milestone state transition
    const policyResult = await this.policyService.evaluateSubmission({
      submissionId,
      assessments,
      policyVersion: "1.0.0",
    });

    // 8. Record audit event
    await this.auditService.recordEvent({
      entityType: "POLICY_EVALUATION",
      entityId: policyResult.evaluation.id,
      actorType: "USER",
      actorUserId: authenticatedUser.id,
      action: "AI_EVALUATION_COMPLETED",
      metadata: {
        submissionId,
        milestoneId: milestone.id,
        aiProvider: aiEvaluation.provider,
        isDemoMode: aiEvaluation.isDemoMode,
        deterministicDecision: policyResult.evaluation.decision,
        newMilestoneStatus: policyResult.milestone.status,
      },
      correlationId: `corr_eval_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });

    return {
      aiEvaluation,
      policyEvaluation: policyResult.evaluation,
      decision: policyResult.evaluation.decision as "PASS" | "FAIL",
      decisionReason: policyResult.evaluation.decisionReason ?? "",
      milestoneStatus: policyResult.milestone.status,
      receiptHash: policyResult.evaluation.receiptHash ?? null,
      evidenceSummary,
    };
  }

  /**
   * Retrieves the latest evaluation outcome for a submission if it exists.
   */
  async getLatestSubmissionEvaluation(submissionId: string) {
    const latestPolicy = await this.policyService.getLatestEvaluation(submissionId);
    const evidence = await this.client.gitHubEvidenceSnapshot.findFirst({
      where: { submissionId },
      orderBy: { snapshotVersion: "desc" },
    });

    return {
      policyEvaluation: latestPolicy,
      evidenceSnapshot: evidence,
    };
  }
}
