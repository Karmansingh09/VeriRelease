/**
 * VeriRelease GitHub Integration Domain Types
 *
 * Strongly typed domain entities, Zod schemas, and data representations for
 * GitHub repositories, webhook deliveries, evidence normalization, and checks.
 */

import { z } from "zod";

// ==========================================
// Enums & Statuses
// ==========================================

export const GITHUB_DELIVERY_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "IGNORED",
] as const;
export type GitHubDeliveryStatus = (typeof GITHUB_DELIVERY_STATUSES)[number];
export const githubDeliveryStatusSchema = z.enum(GITHUB_DELIVERY_STATUSES);

export const GITHUB_CHECK_STATUSES = [
  "PENDING",
  "SUCCESS",
  "FAILURE",
  "UNAVAILABLE",
] as const;
export type GitHubCheckStatus = (typeof GITHUB_CHECK_STATUSES)[number];
export const githubCheckStatusSchema = z.enum(GITHUB_CHECK_STATUSES);

// ==========================================
// Provider Models (External API Normalization)
// ==========================================

export interface GitHubInstallationDetails {
  id: number;
  account: {
    id: number;
    login: string;
  };
  repositorySelection: "all" | "selected";
}

export const gitHubInstallationDetailsSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string().trim().min(1),
  }),
  repositorySelection: z.enum(["all", "selected"]),
});

export interface GitHubRepoMetadata {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
}

export const gitHubRepoMetadataSchema = z.object({
  id: z.number().int().positive(),
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  fullName: z.string().trim().min(1),
  isPrivate: z.boolean(),
  defaultBranch: z.string().trim().min(1).default("main"),
  htmlUrl: z.string().url(),
  description: z.string().nullable().optional(),
});

export interface GitHubPullRequestDetails {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  isMerged: boolean;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string;
  headRepoId: number | null;
  baseSha: string;
  baseRef: string;
  baseRepoId: number | null;
  authorUsername: string;
  authorId: number;
  htmlUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export const gitHubPullRequestDetailsSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string().trim().min(1),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  isMerged: z.boolean(),
  mergedAt: z.date().nullable().optional(),
  mergeCommitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .nullable()
    .optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i, "headSha must be a 40-character hex SHA"),
  headRef: z.string().trim().min(1),
  headRepoId: z.number().int().positive().nullable().optional(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i, "baseSha must be a 40-character hex SHA"),
  baseRef: z.string().trim().min(1),
  baseRepoId: z.number().int().positive().nullable().optional(),
  authorUsername: z.string().trim().min(1),
  authorId: z.number().int().positive(),
  htmlUrl: z.string().url(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface GitHubCommitMetadata {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  committerName: string;
  committerEmail: string;
  committedDate: Date;
  treeSha: string;
  parents: string[];
}

export const gitHubCommitMetadataSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredDate: z.date(),
  committerName: z.string(),
  committerEmail: z.string(),
  committedDate: z.date(),
  treeSha: z.string().regex(/^[0-9a-f]{40}$/i),
  parents: z.array(z.string().regex(/^[0-9a-f]{40}$/i)),
});

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | null;
  startedAt: Date | null;
  completedAt: Date | null;
  detailsUrl: string | null;
}

export const gitHubCheckRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "timed_out",
      "action_required",
      "skipped",
    ])
    .nullable(),
  startedAt: z.date().nullable().optional(),
  completedAt: z.date().nullable().optional(),
  detailsUrl: z.string().url().nullable().optional(),
});

export interface GitHubChecksSummary {
  status: GitHubCheckStatus;
  totalCount: number;
  checkRuns: GitHubCheckRun[];
}

export const gitHubChecksSummarySchema = z.object({
  status: githubCheckStatusSchema,
  totalCount: z.number().int().nonnegative(),
  checkRuns: z.array(gitHubCheckRunSchema),
});

// ==========================================
// Persisted Domain Entities
// ==========================================

export interface GitHubRepository {
  id: string;
  repoId: bigint;
  owner: string;
  name: string;
  fullName: string;
  installationId?: bigint | null;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const gitHubRepositorySchema = z.object({
  id: z.string().min(1),
  repoId: z.bigint().positive(),
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  fullName: z.string().trim().min(1),
  installationId: z.bigint().positive().nullable().optional(),
  isPrivate: z.boolean(),
  defaultBranch: z.string().trim().min(1).default("main"),
  htmlUrl: z.string().url(),
  description: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface GitHubWebhookDelivery {
  id: string;
  deliveryId: string;
  eventType: string;
  action?: string | null;
  status: GitHubDeliveryStatus;
  repositoryId?: bigint | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  errorMessage?: string | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const gitHubWebhookDeliverySchema = z.object({
  id: z.string().min(1),
  deliveryId: z.string().trim().min(1).max(64),
  eventType: z.string().trim().min(1),
  action: z.string().nullable().optional(),
  status: githubDeliveryStatusSchema,
  repositoryId: z.bigint().positive().nullable().optional(),
  payload: z.record(z.unknown()),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  errorMessage: z.string().nullable().optional(),
  processedAt: z.date().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface GitHubEvidenceSnapshot {
  id: string;
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
  collectedAt: Date;
  provider: string;
  apiVersion: string;
}

export const gitHubEvidenceSnapshotSchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().min(1),
  milestoneId: z.string().min(1),
  snapshotVersion: z.number().int().positive(),
  repositoryId: z.bigint().positive(),
  repoOwner: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  prNumber: z.number().int().positive(),
  prId: z.bigint().positive().nullable().optional(),
  prUrl: z.string().url(),
  prTitle: z.string().trim().min(1),
  prBody: z.string().nullable().optional(),
  prAuthor: z.string().trim().min(1),
  prAuthorId: z.bigint().positive().nullable().optional(),
  prState: z.string().trim().min(1),
  isMerged: z.boolean(),
  mergedAt: z.date().nullable().optional(),
  mergeCommitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .nullable()
    .optional(),
  headBranch: z.string().trim().min(1),
  headCommitSha: z.string().regex(/^[0-9a-f]{40}$/i),
  baseBranch: z.string().trim().min(1),
  baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/i),
  commitCount: z.number().int().nonnegative(),
  commits: z.array(gitHubCommitMetadataSchema),
  checks: gitHubChecksSummarySchema,
  checksStatus: githubCheckStatusSchema,
  rawPayload: z.record(z.unknown()).nullable().optional(),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  collectedAt: z.date(),
  provider: z.string().trim().min(1),
  apiVersion: z.string().trim().min(1),
});
