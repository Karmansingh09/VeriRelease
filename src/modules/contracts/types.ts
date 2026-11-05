/**
 * VeriRelease Contracts & Milestones Domain Models
 *
 * Strongly typed entities, enums, and Zod schemas for Contracts, Milestones,
 * Acceptance Criteria, and Milestone Submissions.
 */

import { z } from "zod";
import {
  type SupportedCurrency,
  supportedCurrencySchema,
  minorUnitsSchema,
} from "../common/money";

// ==========================================
// User Domain Types
// ==========================================

export const USER_ROLES = ["CLIENT", "DEVELOPER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  paypalPayerId?: string | null;
  paypalReceiverEmail?: string | null;
  githubUsername?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const userSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  role: userRoleSchema,
  paypalPayerId: z.string().nullable().optional(),
  paypalReceiverEmail: z.string().email().nullable().optional(),
  githubUsername: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ==========================================
// Contract Domain Types
// ==========================================

export const CONTRACT_STATUSES = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const contractStatusSchema = z.enum(CONTRACT_STATUSES);

export interface Contract {
  id: string;
  title: string;
  description: string;
  clientId: string;
  developerId: string;
  status: ContractStatus;
  totalAmountMinorUnits: bigint;
  currency: SupportedCurrency;
  githubRepoOwner: string;
  githubRepoName: string;
  createdAt: Date;
  updatedAt: Date;
}

export const contractSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    clientId: z.string().min(1),
    developerId: z.string().min(1),
    status: contractStatusSchema,
    totalAmountMinorUnits: minorUnitsSchema.refine((v) => v > 0n, {
      message: "Contract totalAmountMinorUnits must be strictly positive (> 0)",
    }),
    currency: supportedCurrencySchema,
    githubRepoOwner: z.string().min(1),
    githubRepoName: z.string().min(1),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((data) => data.clientId !== data.developerId, {
    message: "Contract clientId and developerId must be distinct actors",
    path: ["developerId"],
  });

// ==========================================
// Milestone Domain Types
// ==========================================

/**
 * Pure verification states. Payment states are strictly excluded.
 */
export const MILESTONE_STATUSES = [
  "DRAFT",
  "FUNDED",
  "SUBMITTED",
  "EVALUATING",
  "ELIGIBLE_FOR_PAYOUT",
  "CHANGES_REQUESTED",
  "DISPUTED",
  "CANCELLED",
] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export const milestoneStatusSchema = z.enum(MILESTONE_STATUSES);

export interface Milestone {
  id: string;
  contractId: string;
  title: string;
  description: string;
  orderIndex: number;
  amountMinorUnits: bigint;
  currency: SupportedCurrency;
  status: MilestoneStatus;
  activeCriteriaVersion: number;
  fundedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const milestoneSchema = z.object({
  id: z.string().min(1),
  contractId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  orderIndex: z.number().int().positive(),
  amountMinorUnits: minorUnitsSchema.refine((v) => v > 0n, {
    message: "Milestone amountMinorUnits must be strictly positive (> 0)",
  }),
  currency: supportedCurrencySchema,
  status: milestoneStatusSchema,
  activeCriteriaVersion: z.number().int().positive(),
  fundedAt: z.date().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ==========================================
// Acceptance Criteria Domain Types
// ==========================================

export const CRITERION_TYPES = [
  "AUTOMATED_TEST",
  "FILE_CHANGE",
  "CODE_QUALITY",
  "SPECIFICATION",
  "MANUAL_APPROVAL",
] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];
export const criterionTypeSchema = z.enum(CRITERION_TYPES);

export interface AcceptanceCriterion {
  id: string;
  milestoneId: string;
  version: number;
  orderIndex: number;
  title: string;
  description: string;
  criterionType: CriterionType;
  isMandatory: boolean;
  createdAt: Date;
}

export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  milestoneId: z.string().min(1),
  version: z.number().int().positive(),
  orderIndex: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  criterionType: criterionTypeSchema,
  isMandatory: z.boolean(),
  createdAt: z.date(),
});

/**
 * Frozen criterion item stored in MilestoneSubmission.criteriaSnapshot.
 */
export interface CriteriaSnapshotItem {
  criterionId: string;
  criterionType: CriterionType;
  description: string;
  isMandatory: boolean;
  orderIndex: number;
  title: string;
}

export const criteriaSnapshotItemSchema = z.object({
  criterionId: z.string().min(1),
  criterionType: criterionTypeSchema,
  description: z.string(),
  isMandatory: z.boolean(),
  orderIndex: z.number().int().positive(),
  title: z.string().min(1),
});

// ==========================================
// Milestone Submission Domain Types
// ==========================================

export const SUBMISSION_STATUSES = ["PENDING", "EVALUATED", "SUPERSEDED"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export const submissionStatusSchema = z.enum(SUBMISSION_STATUSES);

export interface MilestoneSubmission {
  id: string;
  milestoneId: string;
  submissionNumber: number;
  prNumber: number;
  prCommitSha: string;
  prUrl: string;
  criteriaVersion: number;
  criteriaSnapshot: readonly CriteriaSnapshotItem[];
  criteriaHash: string;
  status: SubmissionStatus;
  submittedById: string;
  submittedAt: Date;
}

export const milestoneSubmissionSchema = z.object({
  id: z.string().min(1),
  milestoneId: z.string().min(1),
  submissionNumber: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  prCommitSha: z.string().regex(/^[0-9a-f]{40}$/, {
    message: "prCommitSha must be a 40-character lowercase hexadecimal SHA-1 string",
  }),
  prUrl: z.string().url(),
  criteriaVersion: z.number().int().positive(),
  criteriaSnapshot: z.array(criteriaSnapshotItemSchema),
  criteriaHash: z.string().regex(/^[0-9a-f]{64}$/, {
    message: "criteriaHash must be a 64-character lowercase hexadecimal SHA-256 string",
  }),
  status: submissionStatusSchema,
  submittedById: z.string().min(1),
  submittedAt: z.date(),
});
