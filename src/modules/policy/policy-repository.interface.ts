/**
 * VeriRelease Policy Repository Interface
 *
 * Defines the policy evaluation persistence boundary.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type {
  PolicyEvaluation,
  PolicyStatus,
  PolicyDecision,
  CriterionEvaluation,
} from "./types";

export interface CreatePolicyEvaluationInput {
  id?: string;
  submissionId: string;
  milestoneId: string;
  criteriaHash: string;
  policyVersion?: string;
  evaluations?: CriterionEvaluation[] | Record<string, unknown> | null;
}

export interface UpdatePolicyEvaluationInput {
  status: PolicyStatus;
  decision?: PolicyDecision | null;
  decisionReason?: string | null;
  evaluations?: CriterionEvaluation[] | Record<string, unknown> | null;
  receiptHash?: string | null;
  completedAt?: Date | null;
}

export interface PolicyRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface PolicyRepository {
  /**
   * Creates a new policy evaluation linked to a submission and criteria hash.
   * Validates cross-milestone and criteria-hash consistency.
   */
  createEvaluation(
    input: CreatePolicyEvaluationInput,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation>;

  /**
   * Updates an in-progress policy evaluation. Enforces that completed evaluations
   * cannot be altered once finalized.
   */
  updateEvaluation(
    id: string,
    input: UpdatePolicyEvaluationInput,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation>;

  /**
   * Retrieves a policy evaluation by its unique ID.
   */
  findById(id: string, options?: PolicyRepositoryOptions): Promise<PolicyEvaluation | null>;

  /**
   * Retrieves all evaluations for a submission, ordered by evaluationNumber ASC.
   */
  findBySubmissionId(
    submissionId: string,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation[]>;

  /**
   * Retrieves the latest evaluation for a submission.
   */
  findLatestBySubmissionId(
    submissionId: string,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation | null>;
}
