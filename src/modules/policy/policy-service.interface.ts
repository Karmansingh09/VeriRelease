/**
 * VeriRelease Policy Evaluation Service Interface
 *
 * Defines the boundary for orchestrating deterministic policy evaluation,
 * persistent PolicyEvaluation records, and Milestone state transitions.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type { Milestone } from "../contracts/types";
import type { MilestoneTransitionResult } from "../contracts/milestone-state-machine";
import type { PolicyEvaluation } from "./types";
import type { PolicyEvaluationOutput } from "./policy-evaluator";

export interface EvaluateSubmissionInput {
  submissionId: string;
  assessments: readonly unknown[];
  policyVersion?: string;
  receiptHash?: string;
}

export interface EvaluateSubmissionResult {
  evaluation: PolicyEvaluation;
  milestone: Milestone;
  evaluationResult: PolicyEvaluationOutput;
  transitionResult: MilestoneTransitionResult;
}

export interface PolicyServiceOptions {
  tx?: PrismaTransactionClient;
}

export interface PolicyService {
  /**
   * Orchestrates the deterministic evaluation of a milestone submission:
   * 1. Acquires database locks on Milestone and MilestoneSubmission in hierarchical order.
   * 2. Validates milestone state machine transitions (SUBMITTED -> EVALUATING).
   * 3. Validates the submission's immutable criteria snapshot against its canonical hash.
   * 4. Executes the pure deterministic policy evaluator against untrusted assessments.
   * 5. Persists the completed PolicyEvaluation record (immutability enforced).
   * 6. Transitions the milestone to ELIGIBLE_FOR_PAYOUT (on PASS) or CHANGES_REQUESTED (on FAIL).
   */
  evaluateSubmission(
    input: EvaluateSubmissionInput,
    options?: PolicyServiceOptions
  ): Promise<EvaluateSubmissionResult>;

  /**
   * Retrieves all policy evaluations for a given submission ordered by evaluationNumber ASC.
   */
  getEvaluationsForSubmission(
    submissionId: string,
    options?: PolicyServiceOptions
  ): Promise<PolicyEvaluation[]>;

  /**
   * Retrieves the authoritative latest policy evaluation for a given submission.
   */
  getLatestEvaluation(
    submissionId: string,
    options?: PolicyServiceOptions
  ): Promise<PolicyEvaluation | null>;
}
