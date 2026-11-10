/**
 * VeriRelease Prisma Milestone Repository Implementation
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../lib/prisma";
import {
  DomainNotFoundError,
  DomainValidationError,
} from "../common/errors";
import type { SupportedCurrency } from "../common/money";
import type {
  MilestoneRepository,
  CreateMilestoneInput,
  CreateCriterionInput,
  MilestoneRepositoryOptions,
} from "./milestone-repository.interface";
import type {
  Milestone,
  MilestoneStatus,
  AcceptanceCriterion,
  CriterionType,
} from "./types";

export class PrismaMilestoneRepository implements MilestoneRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: MilestoneRepositoryOptions): DbClient {
    return options?.tx ?? this.client;
  }

  async create(
    input: CreateMilestoneInput,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone & { criteria: AcceptanceCriterion[] }> {
    if (input.amountMinorUnits <= 0n) {
      throw new DomainValidationError(
        `Milestone amountMinorUnits must be strictly positive (> 0), got: ${input.amountMinorUnits}`
      );
    }

    if (input.orderIndex <= 0) {
      throw new DomainValidationError(
        `Milestone orderIndex must be positive (> 0), got: ${input.orderIndex}`
      );
    }

    const runInTx = async (tx: PrismaTransactionClient) => {
      // 1. Verify contract exists and currency matches
      const contract = await tx.contract.findUnique({
        where: { id: input.contractId },
      });
      if (!contract) {
        throw new DomainNotFoundError("Contract", input.contractId);
      }
      if (contract.currency !== input.currency) {
        throw new DomainValidationError(
          `Milestone currency '${input.currency}' does not match contract currency '${contract.currency}'`
        );
      }

      // 2. Validate criteria if provided
      if (input.criteria) {
        const orderIndices = new Set<number>();
        for (const c of input.criteria) {
          if (c.orderIndex <= 0) {
            throw new DomainValidationError(
              `Criterion orderIndex must be positive (> 0), got: ${c.orderIndex}`
            );
          }
          if (orderIndices.has(c.orderIndex)) {
            throw new DomainValidationError(
              `Duplicate criterion orderIndex ${c.orderIndex} in milestone creation`
            );
          }
          orderIndices.add(c.orderIndex);
        }
      }

      const milestoneId = input.id ?? `mls_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

      try {
        const mRow = await tx.milestone.create({
          data: {
            id: milestoneId,
            contractId: input.contractId,
            title: input.title,
            description: input.description,
            orderIndex: input.orderIndex,
            amountMinorUnits: input.amountMinorUnits,
            currency: input.currency,
            status: input.status ?? "DRAFT",
            activeCriteriaVersion: 1,
          },
        });

        const createdCriteria: AcceptanceCriterion[] = [];
        if (input.criteria && input.criteria.length > 0) {
          for (const c of input.criteria) {
            const critId = c.id ?? `crit_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
            const cRow = await tx.acceptanceCriterion.create({
              data: {
                id: critId,
                milestoneId: milestoneId,
                version: 1,
                orderIndex: c.orderIndex,
                title: c.title,
                description: c.description,
                criterionType: c.criterionType,
                isMandatory: c.isMandatory ?? true,
              },
            });

            createdCriteria.push({
              id: cRow.id,
              milestoneId: cRow.milestoneId,
              version: cRow.version,
              orderIndex: cRow.orderIndex,
              title: cRow.title,
              description: cRow.description,
              criterionType: cRow.criterionType as CriterionType,
              isMandatory: cRow.isMandatory,
              createdAt: cRow.createdAt,
            });
          }
        }

        return {
          id: mRow.id,
          contractId: mRow.contractId,
          title: mRow.title,
          description: mRow.description,
          orderIndex: mRow.orderIndex,
          amountMinorUnits: BigInt(mRow.amountMinorUnits),
          currency: mRow.currency as SupportedCurrency,
          status: mRow.status as MilestoneStatus,
          activeCriteriaVersion: mRow.activeCriteriaVersion,
          fundedAt: mRow.fundedAt,
          createdAt: mRow.createdAt,
          updatedAt: mRow.updatedAt,
          criteria: createdCriteria,
        };
      } catch (err: unknown) {
        // Intercept PostgreSQL trigger violation (e.g. over-allocation code 23514)
        const message = err instanceof Error ? err.message : String(err);
        if (
          (message.includes("exceed") && message.includes("contract total")) ||
          message.includes("23514") ||
          message.includes("SECURITY VIOLATION")
        ) {
          throw new DomainValidationError(
            "Milestone amount exceeds available contract totalAmountMinorUnits allocation",
            message
          );
        }
        throw err;
      }
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  async findById(
    id: string,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone | null> {
    const db = this.getClient(options);
    const row = await db.milestone.findUnique({ where: { id } });
    if (!row) return null;

    return {
      id: row.id,
      contractId: row.contractId,
      title: row.title,
      description: row.description,
      orderIndex: row.orderIndex,
      amountMinorUnits: BigInt(row.amountMinorUnits),
      currency: row.currency as SupportedCurrency,
      status: row.status as MilestoneStatus,
      activeCriteriaVersion: row.activeCriteriaVersion,
      fundedAt: row.fundedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findByIdWithCriteria(
    id: string,
    version?: number,
    options?: MilestoneRepositoryOptions
  ): Promise<(Milestone & { criteria: AcceptanceCriterion[] }) | null> {
    const db = this.getClient(options);
    const milestone = await db.milestone.findUnique({ where: { id } });
    if (!milestone) return null;

    const targetVersion = version ?? milestone.activeCriteriaVersion;
    const criteriaRows = await db.acceptanceCriterion.findMany({
      where: {
        milestoneId: id,
        version: targetVersion,
      },
      orderBy: { orderIndex: "asc" },
    });

    return {
      id: milestone.id,
      contractId: milestone.contractId,
      title: milestone.title,
      description: milestone.description,
      orderIndex: milestone.orderIndex,
      amountMinorUnits: BigInt(milestone.amountMinorUnits),
      currency: milestone.currency as SupportedCurrency,
      status: milestone.status as MilestoneStatus,
      activeCriteriaVersion: milestone.activeCriteriaVersion,
      fundedAt: milestone.fundedAt,
      createdAt: milestone.createdAt,
      updatedAt: milestone.updatedAt,
      criteria: criteriaRows.map((c) => ({
        id: c.id,
        milestoneId: c.milestoneId,
        version: c.version,
        orderIndex: c.orderIndex,
        title: c.title,
        description: c.description,
        criterionType: c.criterionType as CriterionType,
        isMandatory: c.isMandatory,
        createdAt: c.createdAt,
      })),
    };
  }

  async findByContractId(
    contractId: string,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone[]> {
    const db = this.getClient(options);
    const rows = await db.milestone.findMany({
      where: { contractId },
      orderBy: { orderIndex: "asc" },
    });

    return rows.map((row) => ({
      id: row.id,
      contractId: row.contractId,
      title: row.title,
      description: row.description,
      orderIndex: row.orderIndex,
      amountMinorUnits: BigInt(row.amountMinorUnits),
      currency: row.currency as SupportedCurrency,
      status: row.status as MilestoneStatus,
      activeCriteriaVersion: row.activeCriteriaVersion,
      fundedAt: row.fundedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async updateStatus(
    id: string,
    status: MilestoneStatus,
    fundedAt?: Date | null,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone> {
    const db = this.getClient(options);
    const existing = await db.milestone.findUnique({ where: { id } });
    if (!existing) {
      throw new DomainNotFoundError("Milestone", id);
    }

    const row = await db.milestone.update({
      where: { id },
      data: {
        status,
        ...(fundedAt !== undefined ? { fundedAt } : {}),
      },
    });

    return {
      id: row.id,
      contractId: row.contractId,
      title: row.title,
      description: row.description,
      orderIndex: row.orderIndex,
      amountMinorUnits: BigInt(row.amountMinorUnits),
      currency: row.currency as SupportedCurrency,
      status: row.status as MilestoneStatus,
      activeCriteriaVersion: row.activeCriteriaVersion,
      fundedAt: row.fundedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async amendCriteria(
    milestoneId: string,
    criteria: CreateCriterionInput[],
    options?: MilestoneRepositoryOptions
  ): Promise<{ activeCriteriaVersion: number; criteria: AcceptanceCriterion[] }> {
    if (!criteria || criteria.length === 0) {
      throw new DomainValidationError(
        "Criteria amendment must define at least one criterion"
      );
    }

    const orderIndices = new Set<number>();
    for (const c of criteria) {
      if (c.orderIndex <= 0) {
        throw new DomainValidationError(
          `Criterion orderIndex must be positive (> 0), got: ${c.orderIndex}`
        );
      }
      if (orderIndices.has(c.orderIndex)) {
        throw new DomainValidationError(
          `Duplicate criterion orderIndex ${c.orderIndex} in criteria amendment`
        );
      }
      orderIndices.add(c.orderIndex);
    }

    const runInTx = async (tx: PrismaTransactionClient) => {
      // 1. Acquire milestone row lock to serialize amendments against submissions
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          activeCriteriaVersion: number;
          status: string;
        }>
      >`SELECT id, "activeCriteriaVersion", status FROM "Milestone" WHERE id = ${milestoneId} FOR UPDATE;`;

      if (!lockedRows || lockedRows.length === 0) {
        throw new DomainNotFoundError("Milestone", milestoneId);
      }

      const locked = lockedRows[0]!;
      if (locked.status === "CANCELLED" || locked.status === "DISPUTED") {
        throw new DomainValidationError(
          `Cannot amend criteria: milestone is in terminal state '${locked.status}'`
        );
      }

      const newVersion = locked.activeCriteriaVersion + 1;
      const createdCriteria: AcceptanceCriterion[] = [];

      // 2. Insert new criteria with version = N + 1 (never mutate historical rows)
      for (const c of criteria) {
        const critId = c.id ?? `crit_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const cRow = await tx.acceptanceCriterion.create({
          data: {
            id: critId,
            milestoneId,
            version: newVersion,
            orderIndex: c.orderIndex,
            title: c.title,
            description: c.description,
            criterionType: c.criterionType,
            isMandatory: c.isMandatory ?? true,
          },
        });

        createdCriteria.push({
          id: cRow.id,
          milestoneId: cRow.milestoneId,
          version: cRow.version,
          orderIndex: cRow.orderIndex,
          title: cRow.title,
          description: cRow.description,
          criterionType: cRow.criterionType as CriterionType,
          isMandatory: cRow.isMandatory,
          createdAt: cRow.createdAt,
        });
      }

      // 3. Update milestone activeCriteriaVersion under lock
      await tx.milestone.update({
        where: { id: milestoneId },
        data: { activeCriteriaVersion: newVersion },
      });

      return {
        activeCriteriaVersion: newVersion,
        criteria: createdCriteria,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  async lockForUpdate(
    id: string,
    tx: PrismaTransactionClient
  ): Promise<Milestone> {
    const lockedRows = await tx.$queryRaw<
      Array<{
        id: string;
        contractId: string;
        title: string;
        description: string;
        orderIndex: number;
        amountMinorUnits: bigint;
        currency: string;
        status: string;
        activeCriteriaVersion: number;
        fundedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >`SELECT * FROM "Milestone" WHERE id = ${id} FOR UPDATE;`;

    if (!lockedRows || lockedRows.length === 0) {
      throw new DomainNotFoundError("Milestone", id);
    }

    const row = lockedRows[0]!;
    return {
      id: row.id,
      contractId: row.contractId,
      title: row.title,
      description: row.description,
      orderIndex: row.orderIndex,
      amountMinorUnits: BigInt(row.amountMinorUnits),
      currency: row.currency as SupportedCurrency,
      status: row.status as MilestoneStatus,
      activeCriteriaVersion: row.activeCriteriaVersion,
      fundedAt: row.fundedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
