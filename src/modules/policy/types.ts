/**
 * VeriRelease Policy Domain Types
 *
 * Strongly typed entities, enums, and Zod schemas for Policy Evaluations
 * and verification receipts.
 */

import { z } from "zod";

// ==========================================
// Policy Enums & Constants
// ==========================================

export const POLICY_STATUSES = ["IN_PROGRESS", "COMPLETED", "FAILED"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export const policyStatusSchema = z.enum(POLICY_STATUSES);

export const POLICY_DECISIONS = ["PASS", "FAIL"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
export const policyDecisionSchema = z.enum(POLICY_DECISIONS);

// ==========================================
// Criterion Evaluation Breakdown
// ==========================================

export interface CriterionEvaluation {
  criterionId: string;
  criterionType: string;
  passed: boolean;
  evidence: Record<string, unknown>;
}

export const criterionEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  criterionType: z.string().min(1),
  passed: z.boolean(),
  evidence: z.record(z.unknown()),
});

// ==========================================
// Policy Evaluation Entity
// ==========================================

export interface PolicyEvaluation {
  id: string;
  submissionId: string;
  milestoneId: string;
  criteriaHash: string;
  evaluationNumber: number;
  policyVersion: string;
  status: PolicyStatus;
  decision: PolicyDecision | null;
  decisionReason?: string | null;
  evaluations: CriterionEvaluation[] | Record<string, unknown> | null;
  receiptHash?: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

export const policyEvaluationSchema = z
  .object({
    id: z.string().min(1),
    submissionId: z.string().min(1),
    milestoneId: z.string().min(1),
    criteriaHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "Must be a 64-character lowercase hex digest"),
    evaluationNumber: z.number().int().positive(),
    policyVersion: z.string().min(1).default("1.0.0"),
    status: policyStatusSchema,
    decision: policyDecisionSchema.nullable().optional(),
    decisionReason: z.string().nullable().optional(),
    evaluations: z
      .union([z.array(criterionEvaluationSchema), z.record(z.unknown())])
      .nullable()
      .optional(),
    receiptHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    completedAt: z.date().nullable().optional(),
    createdAt: z.date(),
  })
  .refine(
    (evalRecord) => {
      // Invariant: chk_completed_evaluation_invariants
      // When status is COMPLETED, decision, completedAt, and evaluations MUST be non-null
      if (evalRecord.status === "COMPLETED") {
        return (
          evalRecord.decision !== null &&
          evalRecord.decision !== undefined &&
          evalRecord.completedAt !== null &&
          evalRecord.completedAt !== undefined &&
          evalRecord.evaluations !== null &&
          evalRecord.evaluations !== undefined
        );
      }
      return true;
    },
    {
      message:
        "Completed policy evaluations must include decision, completedAt, and evaluations breakdown",
      path: ["status"],
    }
  );
