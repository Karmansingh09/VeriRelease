/**
 * VeriRelease Deterministic Demo AI Provider
 *
 * Implements high-fidelity, reproducible AI milestone evaluation for hackathon demonstrations.
 * Evaluates real normalized GitHub evidence against frozen criteria snapshots without
 * requiring live external OpenAI credentials.
 *
 * Strict Rules:
 * - Marked explicitly as DEMO MODE (`isDemoMode: true`, `provider: 'deterministic-demo'`).
 * - Never claims CI passed if no actual check run succeeded.
 * - AI output is untrusted input consumed solely by the deterministic policy engine.
 */

import type { AiEvaluationProvider } from "../ai-provider.interface";
import type {
  AiEvaluationRequest,
  AiEvaluationResult,
  AiCriterionResult,
} from "../types";

export class DemoAiProvider implements AiEvaluationProvider {
  readonly name = "deterministic-demo";
  readonly isDemo = true;

  async evaluate(request: AiEvaluationRequest): Promise<AiEvaluationResult> {
    const { criteria, evidence, submission } = request;

    const missingEvidence: string[] = [];
    const risks: string[] = [];
    const criterionAssessments: AiCriterionResult[] = [];

    // Verify presence of basic submission evidence
    if (!evidence.headSha || evidence.headSha.length !== 40) {
      missingEvidence.push("Valid 40-character commit SHA is missing from GitHub evidence");
    }

    if (evidence.commitsCount === 0) {
      missingEvidence.push("No commits found in pull request");
    }

    if (evidence.changedFilesCount === 0) {
      missingEvidence.push("No changed files found in pull request");
    }

    if (evidence.ciStatus === "UNAVAILABLE") {
      risks.push("No automated CI/check run results are available for this commit");
    } else if (evidence.ciStatus === "FAILURE") {
      risks.push(`CI checks reported failure (${evidence.checkRunsFailed} check runs failed)`);
    }

    if (evidence.isDraft) {
      risks.push("Pull request is currently marked as DRAFT on GitHub");
    }

    // Evaluate each criterion deterministically
    let allMandatoryPassed = true;

    for (const criterion of criteria) {
      let passed = false;
      let confidence = 0.95;
      let reason = "";
      const supportingEvidence: Record<string, unknown> = {
        criterionType: criterion.criterionType,
        prNumber: submission.prNumber,
        commitSha: submission.prCommitSha,
      };

      switch (criterion.criterionType) {
        case "AUTOMATED_TEST": {
          if (evidence.ciStatus === "SUCCESS") {
            passed = true;
            confidence = 0.98;
            reason = `Automated CI checks completed successfully on GitHub (${evidence.checkRunsSuccessful} checks passed)`;
            supportingEvidence.checkRunsSuccessful = evidence.checkRunsSuccessful;
            supportingEvidence.ciStatus = "SUCCESS";
          } else if (evidence.ciStatus === "FAILURE") {
            passed = false;
            confidence = 0.99;
            reason = `Automated CI checks failed on GitHub (${evidence.checkRunsFailed} failed checks)`;
            supportingEvidence.checkRunsFailed = evidence.checkRunsFailed;
            supportingEvidence.ciStatus = "FAILURE";
          } else {
            // UNAVAILABLE or PENDING
            passed = false;
            confidence = 0.85;
            reason = `Automated test verification requires passing CI check runs; current status is ${evidence.ciStatus}`;
            supportingEvidence.ciStatus = evidence.ciStatus;
          }
          break;
        }

        case "FILE_CHANGE": {
          if (evidence.changedFilesCount > 0) {
            passed = true;
            confidence = 0.92;
            reason = `Verified PR modifies code deliverables (${evidence.changedFilesCount} files changed across ${evidence.commitsCount} commits)`;
            supportingEvidence.changedFilesCount = evidence.changedFilesCount;
            supportingEvidence.commitsCount = evidence.commitsCount;
          } else {
            passed = false;
            confidence = 0.95;
            reason = "No file changes detected in pull request deliverable";
          }
          break;
        }

        case "CODE_QUALITY": {
          if (evidence.ciStatus !== "FAILURE" && evidence.changedFilesCount > 0) {
            passed = true;
            confidence = 0.90;
            reason = `Code changes submitted without CI quality check failures (${evidence.changedFilesCount} files inspected)`;
            supportingEvidence.ciStatus = evidence.ciStatus;
            supportingEvidence.changedFilesCount = evidence.changedFilesCount;
          } else {
            passed = false;
            confidence = 0.90;
            reason = evidence.ciStatus === "FAILURE"
              ? "CI quality checks failed on submitted commit"
              : "No file changes available to evaluate code quality";
          }
          break;
        }

        case "SPECIFICATION": {
          // Inspect title, body, and description for matching deliverables
          const text = `${evidence.prTitle} ${evidence.prBody}`.toLowerCase();
          const matches = text.length > 10;

          if (matches) {
            passed = true;
            confidence = 0.88;
            reason = `Pull request documentation addresses milestone deliverable specification ('${criterion.title}')`;
            supportingEvidence.prTitle = evidence.prTitle;
          } else {
            passed = false;
            confidence = 0.75;
            reason = `Pull request description provides insufficient detail to confirm specification compliance for '${criterion.title}'`;
          }
          break;
        }

        case "MANUAL_APPROVAL":
        default: {
          // Manual approval criterion: passes provisionally if PR is non-draft with valid commits
          if (!evidence.isDraft && evidence.commitsCount > 0) {
            passed = true;
            confidence = 0.85;
            reason = `Preliminary inspection verified non-draft PR with ${evidence.commitsCount} commits ready for client sign-off`;
          } else {
            passed = false;
            confidence = 0.85;
            reason = "Deliverable requires client verification or non-draft status";
          }
          break;
        }
      }

      if (criterion.isMandatory && !passed) {
        allMandatoryPassed = false;
      }

      criterionAssessments.push({
        criterionId: criterion.criterionId,
        criterionTitle: criterion.title,
        criterionType: criterion.criterionType,
        isMandatory: criterion.isMandatory,
        passed,
        confidence,
        reason,
        supportingEvidence,
      });
    }

    const passedCount = criterionAssessments.filter((c) => c.passed).length;
    const totalCount = criterionAssessments.length;

    let suggestedAction: "APPROVE_PAYOUT_ELIGIBILITY" | "REQUEST_CHANGES" | "MANUAL_REVIEW";
    let overallAssessment: string;

    if (allMandatoryPassed && missingEvidence.length === 0) {
      suggestedAction = "APPROVE_PAYOUT_ELIGIBILITY";
      overallAssessment = `AI evaluation verified deliverable compliance: ${passedCount}/${totalCount} criteria satisfied including all mandatory requirements. Recommended for deterministic policy engine payout eligibility review.`;
    } else if (risks.some((r) => r.includes("failed"))) {
      suggestedAction = "REQUEST_CHANGES";
      overallAssessment = `AI evaluation identified deliverable issues: ${totalCount - passedCount} criteria failed. Suggested action: request changes from developer to address failed automated checks.`;
    } else {
      suggestedAction = "REQUEST_CHANGES";
      overallAssessment = `AI evaluation found incomplete evidence: ${missingEvidence.join("; ") || "Certain mandatory criteria were not satisfied"}.`;
    }

    return {
      overallAssessment,
      criterionAssessments,
      missingEvidence,
      risks,
      suggestedAction,
      provider: "deterministic-demo",
      model: "verirelease-evaluator-demo-v1",
      isDemoMode: true,
      evaluatedAt: new Date(),
    };
  }
}
