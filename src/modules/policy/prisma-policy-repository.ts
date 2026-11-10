/**
 * VeriRelease Prisma Policy Repository Implementation
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../lib/prisma";
import {
  DomainNotFoundError,
  DomainValidationError,
} from "../common/errors";
import type {
  PolicyRepository,
  CreatePolicyEvaluationInput,
  UpdatePolicyEvaluationInput,
  PolicyRepositoryOptions,
} from "./policy-repository.interface";
import type {
  PolicyEvaluation,
  PolicyStatus,
  PolicyDecision,
  CriterionEvaluation,
} from "./types";

export class PrismaPolicyRepository implements PolicyRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: PolicyRepositoryOptions): DbClient {
    return options?.tx ?? this.client;
  }

  async createEvaluation(
    input: CreatePolicyEvaluationInput,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation> {
    const runInTx = async (tx: PrismaTransactionClient) => {
      // 1. Acquire exclusive row lock on MilestoneSubmission to serialize evaluation creation for this submission
      const lockedSubmissions = await tx.$queryRaw<
        Array<{
          id: string;
          milestoneId: string;
          criteriaHash: string;
        }>
      >`SELECT id, "milestoneId", "criteriaHash" FROM "MilestoneSubmission" WHERE id = ${input.submissionId} FOR UPDATE;`;

      if (!lockedSubmissions || lockedSubmissions.length === 0) {
        throw new DomainNotFoundError("MilestoneSubmission", input.submissionId);
      }

      const submission = lockedSubmissions[0]!;

      // 2. Reject cross-milestone submission/evaluation mismatches
      if (submission.milestoneId !== input.milestoneId) {
        throw new DomainValidationError(
          `Cross-milestone mismatch: submission '${input.submissionId}' belongs to milestone '${submission.milestoneId}', not '${input.milestoneId}'`
        );
      }

      // 3. Reject criteria hash mismatches
      if (submission.criteriaHash !== input.criteriaHash) {
        throw new DomainValidationError(
          `Criteria hash mismatch: provided hash '${input.criteriaHash}' does not match submission criteriaHash '${submission.criteriaHash}'`
        );
      }

      // 4. Sequential evaluation number allocation for this submission (under row lock)
      const maxRow = await tx.$queryRaw<Array<{ max_num: number | null }>>`
        SELECT MAX("evaluationNumber") as max_num FROM "PolicyEvaluation" WHERE "submissionId" = ${input.submissionId};
      `;
      const evaluationNumber = (maxRow?.[0]?.max_num ?? 0) + 1;

      const evalId = input.id ?? `peval_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

      const row = await tx.policyEvaluation.create({
        data: {
          id: evalId,
          submissionId: input.submissionId,
          milestoneId: input.milestoneId,
          criteriaHash: input.criteriaHash,
          evaluationNumber,
          policyVersion: input.policyVersion ?? "1.0.0",
          status: "IN_PROGRESS",
          decision: null,
          decisionReason: null,
          evaluations: input.evaluations ? (input.evaluations as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          receiptHash: null,
          completedAt: null,
        },
      });

      return {
        id: row.id,
        submissionId: row.submissionId,
        milestoneId: row.milestoneId,
        criteriaHash: row.criteriaHash,
        evaluationNumber: row.evaluationNumber,
        policyVersion: row.policyVersion,
        status: row.status as PolicyStatus,
        decision: row.decision as PolicyDecision | null,
        decisionReason: row.decisionReason,
        evaluations: row.evaluations as unknown as CriterionEvaluation[] | Record<string, unknown> | null,
        receiptHash: row.receiptHash,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  async updateEvaluation(
    id: string,
    input: UpdatePolicyEvaluationInput,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation> {
    const runInTx = async (tx: PrismaTransactionClient) => {
      const existing = await tx.policyEvaluation.findUnique({ where: { id } });
      if (!existing) {
        throw new DomainNotFoundError("PolicyEvaluation", id);
      }

      // Domain invariant: completed evaluations are strictly immutable
      if (existing.status === "COMPLETED") {
        throw new DomainValidationError(
          `Cannot update policy evaluation '${id}': evaluation is already COMPLETED and strictly immutable`
        );
      }

      // Validate COMPLETED requirements (chk_completed_evaluation_invariants)
      if (input.status === "COMPLETED") {
        if (!input.decision) {
          throw new DomainValidationError(
            "Completed policy evaluation must specify a decision ('PASS' or 'FAIL')"
          );
        }
        if (!input.evaluations) {
          throw new DomainValidationError(
            "Completed policy evaluation must provide evaluations evidence"
          );
        }
      }

      const completedAt =
        input.status === "COMPLETED"
          ? input.completedAt ?? new Date()
          : input.completedAt !== undefined
            ? input.completedAt
            : existing.completedAt;

      const row = await tx.policyEvaluation.update({
        where: { id },
        data: {
          status: input.status,
          decision: input.decision !== undefined ? input.decision : existing.decision,
          decisionReason:
            input.decisionReason !== undefined ? input.decisionReason : existing.decisionReason,
          evaluations:
            input.evaluations !== undefined
              ? input.evaluations === null
                ? Prisma.JsonNull
                : (input.evaluations as unknown as Prisma.InputJsonValue)
              : existing.evaluations === null
                ? Prisma.JsonNull
                : (existing.evaluations as unknown as Prisma.InputJsonValue),
          receiptHash:
            input.receiptHash !== undefined ? input.receiptHash : existing.receiptHash,
          completedAt,
        },
      });

      return {
        id: row.id,
        submissionId: row.submissionId,
        milestoneId: row.milestoneId,
        criteriaHash: row.criteriaHash,
        evaluationNumber: row.evaluationNumber,
        policyVersion: row.policyVersion,
        status: row.status as PolicyStatus,
        decision: row.decision as PolicyDecision | null,
        decisionReason: row.decisionReason,
        evaluations: row.evaluations as unknown as CriterionEvaluation[] | Record<string, unknown> | null,
        receiptHash: row.receiptHash,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  async findById(
    id: string,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation | null> {
    const db = this.getClient(options);
    const row = await db.policyEvaluation.findUnique({ where: { id } });
    if (!row) return null;

    return {
      id: row.id,
      submissionId: row.submissionId,
      milestoneId: row.milestoneId,
      criteriaHash: row.criteriaHash,
      evaluationNumber: row.evaluationNumber,
      policyVersion: row.policyVersion,
      status: row.status as PolicyStatus,
      decision: row.decision as PolicyDecision | null,
      decisionReason: row.decisionReason,
      evaluations: row.evaluations as unknown as CriterionEvaluation[] | Record<string, unknown> | null,
      receiptHash: row.receiptHash,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    };
  }

  async findBySubmissionId(
    submissionId: string,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation[]> {
    const db = this.getClient(options);
    const rows = await db.policyEvaluation.findMany({
      where: { submissionId },
      orderBy: { evaluationNumber: "asc" },
    });

    return rows.map((row) => ({
      id: row.id,
      submissionId: row.submissionId,
      milestoneId: row.milestoneId,
      criteriaHash: row.criteriaHash,
      evaluationNumber: row.evaluationNumber,
      policyVersion: row.policyVersion,
      status: row.status as PolicyStatus,
      decision: row.decision as PolicyDecision | null,
      decisionReason: row.decisionReason,
      evaluations: row.evaluations as unknown as CriterionEvaluation[] | Record<string, unknown> | null,
      receiptHash: row.receiptHash,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    }));
  }

  async findLatestBySubmissionId(
    submissionId: string,
    options?: PolicyRepositoryOptions
  ): Promise<PolicyEvaluation | null> {
    const db = this.getClient(options);
    const row = await db.policyEvaluation.findFirst({
      where: { submissionId },
      orderBy: { evaluationNumber: "desc" },
    });
    if (!row) return null;

    return {
      id: row.id,
      submissionId: row.submissionId,
      milestoneId: row.milestoneId,
      criteriaHash: row.criteriaHash,
      evaluationNumber: row.evaluationNumber,
      policyVersion: row.policyVersion,
      status: row.status as PolicyStatus,
      decision: row.decision as PolicyDecision | null,
      decisionReason: row.decisionReason,
      evaluations: row.evaluations as unknown as CriterionEvaluation[] | Record<string, unknown> | null,
      receiptHash: row.receiptHash,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    };
  }
}
