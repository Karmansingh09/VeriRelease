/**
 * VeriRelease AI Evaluation Domain Types
 *
 * Types for AI-assisted milestone evidence evaluation against frozen criteria snapshots.
 *
 * CRITICAL ARCHITECTURAL BOUNDARIES:
 * - AI evaluates evidence; it NEVER authorizes or executes payments.
 * - AI output is untrusted input to the deterministic policy engine.
 * - ELIGIBLE_FOR_PAYOUT can only be decided by the deterministic policy engine.
 * - AI must never claim CI passed when no actual check result exists.
 */

import { z } from "zod";
import type { CriteriaSnapshotItem } from "../contracts/types";

export interface NormalizedEvidenceSummary {
  prNumber: number;
  prTitle: string;
  prBody: string;
  prUrl: string;
  prState: string;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  commitsCount: number;
  changedFilesCount: number;
  checkRunsCount: number;
  checkRunsSuccessful: number;
  checkRunsFailed: number;
  ciStatus: "PENDING" | "SUCCESS" | "FAILURE" | "UNAVAILABLE";
  rawEvidenceHash?: string;
}

export interface AiEvaluationRequest {
  contract: {
    id: string;
    title: string;
    description: string;
    githubRepo: string;
  };
  milestone: {
    id: string;
    title: string;
    description: string;
  };
  submission: {
    id: string;
    submissionNumber: number;
    prNumber: number;
    prCommitSha: string;
    prUrl: string;
  };
  criteria: readonly CriteriaSnapshotItem[];
  evidence: NormalizedEvidenceSummary;
}

export interface AiCriterionResult {
  criterionId: string;
  criterionTitle: string;
  criterionType: string;
  isMandatory: boolean;
  passed: boolean;
  confidence: number; // 0.0 to 1.0
  reason: string;
  supportingEvidence: Record<string, unknown>;
}

export interface AiEvaluationResult {
  overallAssessment: string;
  criterionAssessments: AiCriterionResult[];
  missingEvidence: string[];
  risks: string[];
  suggestedAction: "APPROVE_PAYOUT_ELIGIBILITY" | "REQUEST_CHANGES" | "MANUAL_REVIEW";
  provider: "openai" | "deterministic-demo";
  model: string;
  isDemoMode: boolean;
  evaluatedAt: Date;
}

export const aiCriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  criterionTitle: z.string(),
  criterionType: z.string(),
  isMandatory: z.boolean(),
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  supportingEvidence: z.record(z.unknown()),
});

export const aiEvaluationResultSchema = z.object({
  overallAssessment: z.string().min(1),
  criterionAssessments: z.array(aiCriterionResultSchema),
  missingEvidence: z.array(z.string()),
  risks: z.array(z.string()),
  suggestedAction: z.enum([
    "APPROVE_PAYOUT_ELIGIBILITY",
    "REQUEST_CHANGES",
    "MANUAL_REVIEW",
  ]),
  provider: z.enum(["openai", "deterministic-demo"]),
  model: z.string(),
  isDemoMode: z.boolean(),
  evaluatedAt: z.date(),
});
