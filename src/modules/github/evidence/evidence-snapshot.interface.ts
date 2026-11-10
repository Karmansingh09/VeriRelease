/**
 * VeriRelease GitHub Evidence Snapshot Repository Interface
 *
 * Defines the persistence boundary for immutable, versioned evidence snapshots.
 */

import type { PrismaTransactionClient } from "../../../lib/prisma";
import type {
  GitHubCheckStatus,
  GitHubChecksSummary,
  GitHubCommitMetadata,
  GitHubEvidenceSnapshot,
} from "../types";

export interface CreateEvidenceSnapshotInput {
  id?: string;
  submissionId: string;
  milestoneId: string;
  snapshotVersion: number;
  repositoryId: bigint;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prId?: bigint | null;
  prUrl: string;
  prTitle: string;
  prBody?: string | null;
  prAuthor: string;
  prAuthorId?: bigint | null;
  prState: string;
  isMerged: boolean;
  mergedAt?: Date | null;
  mergeCommitSha?: string | null;
  headBranch: string;
  headCommitSha: string;
  baseBranch: string;
  baseCommitSha: string;
  commitCount: number;
  commits: GitHubCommitMetadata[];
  checks: GitHubChecksSummary;
  checksStatus: GitHubCheckStatus;
  rawPayload?: Record<string, unknown> | null;
  evidenceHash: string;
  collectedAt?: Date;
  provider?: string;
  apiVersion?: string;
}

export interface EvidenceSnapshotOptions {
  tx?: PrismaTransactionClient;
}

export interface EvidenceSnapshotRepository {
  /**
   * Persists an immutable GitHub evidence snapshot under submission versioning.
   */
  create(
    input: CreateEvidenceSnapshotInput,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot>;

  /**
   * Finds the latest evidence snapshot for a submission by submission ID.
   */
  findLatestBySubmissionId(
    submissionId: string,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot | null>;

  /**
   * Finds a specific versioned snapshot for a submission.
   */
  findBySubmissionAndVersion(
    submissionId: string,
    snapshotVersion: number,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot | null>;

  /**
   * Finds an evidence snapshot by its primary ID.
   */
  findById(
    id: string,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot | null>;

  /**
   * Allocates the next sequential snapshot version number for a submission.
   */
  getNextSnapshotVersion(
    submissionId: string,
    options?: EvidenceSnapshotOptions
  ): Promise<number>;
}
