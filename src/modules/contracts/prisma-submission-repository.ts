/**
 * VeriRelease Prisma Milestone Submission Repository Implementation
 *
 * Implements authoritative criteria snapshotting under milestone lock
 * with canonical RFC 8785 SHA-256 criteria hash calculation.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../lib/prisma";
import { hashCanonicalJson } from "../common/canonical-json";
import {
  DomainNotFoundError,
  DomainValidationError,
} from "../common/errors";
import { transitionMilestone } from "./milestone-state-machine";
import type {
  SubmissionRepository,
  CreateSubmissionInput,
  SubmissionRepositoryOptions,
} from "./submission-repository.interface";
import type {
  MilestoneSubmission,
  SubmissionStatus,
  MilestoneStatus,
  CriteriaSnapshotItem,
  CriterionType,
} from "./types";

export class PrismaSubmissionRepository implements SubmissionRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: SubmissionRepositoryOptions): DbClient {
    return options?.tx ?? this.client;
  }

  async createSubmission(
    input: CreateSubmissionInput,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission> {
    const runInTx = async (tx: PrismaTransactionClient) => {
      // 1. Acquire milestone row lock to serialize submissions against criteria amendments
      const lockedMilestones = await tx.$queryRaw<
        Array<{
          id: string;
          contractId: string;
          status: string;
          amountMinorUnits: bigint;
          activeCriteriaVersion: number;
        }>
      >`SELECT id, "contractId", status, "amountMinorUnits", "activeCriteriaVersion" FROM "Milestone" WHERE id = ${input.milestoneId} FOR UPDATE;`;

      if (!lockedMilestones || lockedMilestones.length === 0) {
        throw new DomainNotFoundError("Milestone", input.milestoneId);
      }

      const locked = lockedMilestones[0]!;

      // 2. Fetch the latest submission for this milestone to allocate sequential submissionNumber
      // and obtain authoritative priorCommitSha for CHANGES_REQUESTED -> SUBMITTED resubmissions
      const previousSubmission = await tx.milestoneSubmission.findFirst({
        where: { milestoneId: input.milestoneId },
        orderBy: { submissionNumber: "desc" },
      });

      const nextSubmissionNumber = (previousSubmission?.submissionNumber ?? 0) + 1;

      // 3. Validate and execute state transition via pure domain state machine.
      // Authoritative previous commit SHA comes strictly from the latest persisted submission.
      const transitionResult = transitionMilestone({
        milestone: {
          id: locked.id,
          status: locked.status as MilestoneStatus,
          amountMinorUnits: BigInt(locked.amountMinorUnits),
        },
        targetStatus: "SUBMITTED",
        actor: "DEVELOPER",
        prNumber: input.prNumber,
        prCommitSha: input.prCommitSha,
        priorCommitSha: previousSubmission?.prCommitSha,
      });

      // 4. Query authoritative active criteria from database (never trust caller snapshots)
      const criteriaRows = await tx.acceptanceCriterion.findMany({
        where: {
          milestoneId: locked.id,
          version: locked.activeCriteriaVersion,
        },
        orderBy: { orderIndex: "asc" },
      });

      if (!criteriaRows || criteriaRows.length === 0) {
        throw new DomainValidationError(
          `Cannot create submission: milestone has zero acceptance criteria for version ${locked.activeCriteriaVersion}`
        );
      }

      // 5. Construct frozen snapshot strictly from authoritative database records
      const snapshotItems: CriteriaSnapshotItem[] = criteriaRows.map((c) => ({
        criterionId: c.id,
        criterionType: c.criterionType as CriterionType,
        description: c.description,
        isMandatory: c.isMandatory,
        orderIndex: c.orderIndex,
        title: c.title,
      }));

      // 6. Compute RFC 8785 canonical JSON SHA-256 hash
      const criteriaHash = hashCanonicalJson(snapshotItems);

      const submissionId =
        input.id ?? `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

      // 7. Verify submittedById User exists
      const user = await tx.user.findUnique({ where: { id: input.submittedById } });
      if (!user) {
        throw new DomainNotFoundError("User", input.submittedById);
      }

      // 8. Persist immutable submission record
      const subRow = await tx.milestoneSubmission.create({
        data: {
          id: submissionId,
          milestoneId: locked.id,
          submissionNumber: nextSubmissionNumber,
          prNumber: input.prNumber,
          prCommitSha: input.prCommitSha.toLowerCase(),
          prUrl: input.prUrl,
          criteriaVersion: locked.activeCriteriaVersion,
          criteriaSnapshot: snapshotItems as unknown as Prisma.InputJsonValue,
          criteriaHash,
          status: "PENDING",
          submittedById: input.submittedById,
        },
      });

      // 9. If milestone status transitioned, update the milestone record
      if (locked.status !== transitionResult.newStatus) {
        await tx.milestone.update({
          where: { id: locked.id },
          data: { status: transitionResult.newStatus },
        });
      }

      return {
        id: subRow.id,
        milestoneId: subRow.milestoneId,
        submissionNumber: subRow.submissionNumber,
        prNumber: subRow.prNumber,
        prCommitSha: subRow.prCommitSha,
        prUrl: subRow.prUrl,
        criteriaVersion: subRow.criteriaVersion,
        criteriaSnapshot: snapshotItems,
        criteriaHash: subRow.criteriaHash,
        status: subRow.status as SubmissionStatus,
        submittedById: subRow.submittedById,
        submittedAt: subRow.submittedAt,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  async findById(
    id: string,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission | null> {
    const db = this.getClient(options);
    const row = await db.milestoneSubmission.findUnique({ where: { id } });
    if (!row) return null;

    return {
      id: row.id,
      milestoneId: row.milestoneId,
      submissionNumber: row.submissionNumber,
      prNumber: row.prNumber,
      prCommitSha: row.prCommitSha,
      prUrl: row.prUrl,
      criteriaVersion: row.criteriaVersion,
      criteriaSnapshot: row.criteriaSnapshot as unknown as CriteriaSnapshotItem[],
      criteriaHash: row.criteriaHash,
      status: row.status as SubmissionStatus,
      submittedById: row.submittedById,
      submittedAt: row.submittedAt,
    };
  }

  async findByMilestoneId(
    milestoneId: string,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission[]> {
    const db = this.getClient(options);
    const rows = await db.milestoneSubmission.findMany({
      where: { milestoneId },
      orderBy: { submissionNumber: "asc" },
    });

    return rows.map((row) => ({
      id: row.id,
      milestoneId: row.milestoneId,
      submissionNumber: row.submissionNumber,
      prNumber: row.prNumber,
      prCommitSha: row.prCommitSha,
      prUrl: row.prUrl,
      criteriaVersion: row.criteriaVersion,
      criteriaSnapshot: row.criteriaSnapshot as unknown as CriteriaSnapshotItem[],
      criteriaHash: row.criteriaHash,
      status: row.status as SubmissionStatus,
      submittedById: row.submittedById,
      submittedAt: row.submittedAt,
    }));
  }

  async findLatestByMilestoneId(
    milestoneId: string,
    options?: SubmissionRepositoryOptions
  ): Promise<MilestoneSubmission | null> {
    const db = this.getClient(options);
    const row = await db.milestoneSubmission.findFirst({
      where: { milestoneId },
      orderBy: { submissionNumber: "desc" },
    });
    if (!row) return null;

    return {
      id: row.id,
      milestoneId: row.milestoneId,
      submissionNumber: row.submissionNumber,
      prNumber: row.prNumber,
      prCommitSha: row.prCommitSha,
      prUrl: row.prUrl,
      criteriaVersion: row.criteriaVersion,
      criteriaSnapshot: row.criteriaSnapshot as unknown as CriteriaSnapshotItem[],
      criteriaHash: row.criteriaHash,
      status: row.status as SubmissionStatus,
      submittedById: row.submittedById,
      submittedAt: row.submittedAt,
    };
  }
}
