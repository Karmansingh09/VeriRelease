/**
 * VeriRelease Milestone Submission Repository Interface
 *
 * Defines the submission persistence and immutable criteria snapshot boundary.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type { MilestoneSubmission } from "./types";

export interface CreateSubmissionInput {
  id?: string;
  milestoneId: string;
  prNumber: number;
  prCommitSha: string;
  prUrl: string;
  submittedById: string;
}

export interface SubmissionRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface SubmissionRepository {
  /**
   * Generates an immutable criteria snapshot from authoritative database records
   * under milestone row lock, computes the canonical RFC 8785 SHA-256 criteriaHash,
   * validates state transition via milestone state machine, and creates a MilestoneSubmission.
   */
  createSubmission(
    input: CreateSubmissionInput,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission>;

  /**
   * Retrieves a submission by its unique ID.
   */
  findById(id: string, options?: SubmissionRepositoryOptions): Promise<MilestoneSubmission | null>;

  /**
   * Retrieves all submissions for a milestone, ordered by submissionNumber ASC.
   */
  findByMilestoneId(
    milestoneId: string,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission[]>;

  /**
   * Retrieves the latest submission for a milestone.
   */
  findLatestByMilestoneId(
    milestoneId: string,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission | null>;
}
