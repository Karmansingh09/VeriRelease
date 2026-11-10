/**
 * VeriRelease Prisma Contract Repository Implementation
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient } from "../../lib/prisma";
import {
  DomainNotFoundError,
  DomainValidationError,
} from "../common/errors";
import type { SupportedCurrency } from "../common/money";
import type {
  ContractRepository,
  CreateContractInput,
  ContractRepositoryOptions,
} from "./contract-repository.interface";
import type { Contract, ContractStatus, Milestone, MilestoneStatus } from "./types";

export class PrismaContractRepository implements ContractRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: ContractRepositoryOptions): DbClient {
    return options?.tx ?? this.client;
  }

  async create(
    input: CreateContractInput,
    options?: ContractRepositoryOptions
  ): Promise<Contract> {
    const db = this.getClient(options);

    if (input.totalAmountMinorUnits <= 0n) {
      throw new DomainValidationError(
        `Contract totalAmountMinorUnits must be strictly positive (> 0), got: ${input.totalAmountMinorUnits}`
      );
    }

    if (input.clientId === input.developerId) {
      throw new DomainValidationError(
        "Contract clientId and developerId must be distinct actors"
      );
    }

    // Verify both client and developer exist
    const clientUser = await db.user.findUnique({ where: { id: input.clientId } });
    if (!clientUser) {
      throw new DomainNotFoundError("User", input.clientId);
    }

    const devUser = await db.user.findUnique({ where: { id: input.developerId } });
    if (!devUser) {
      throw new DomainNotFoundError("User", input.developerId);
    }

    const id = input.id ?? `cnt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const row = await db.contract.create({
      data: {
        id,
        title: input.title,
        description: input.description,
        clientId: input.clientId,
        developerId: input.developerId,
        status: input.status ?? "DRAFT",
        totalAmountMinorUnits: input.totalAmountMinorUnits,
        currency: input.currency,
        githubRepoOwner: input.githubRepoOwner,
        githubRepoName: input.githubRepoName,
      },
    });

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      clientId: row.clientId,
      developerId: row.developerId,
      status: row.status as ContractStatus,
      totalAmountMinorUnits: BigInt(row.totalAmountMinorUnits),
      currency: row.currency as SupportedCurrency,
      githubRepoOwner: row.githubRepoOwner,
      githubRepoName: row.githubRepoName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findById(
    id: string,
    options?: ContractRepositoryOptions
  ): Promise<Contract | null> {
    const db = this.getClient(options);
    const row = await db.contract.findUnique({ where: { id } });
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      clientId: row.clientId,
      developerId: row.developerId,
      status: row.status as ContractStatus,
      totalAmountMinorUnits: BigInt(row.totalAmountMinorUnits),
      currency: row.currency as SupportedCurrency,
      githubRepoOwner: row.githubRepoOwner,
      githubRepoName: row.githubRepoName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findByIdWithMilestones(
    id: string,
    options?: ContractRepositoryOptions
  ): Promise<(Contract & { milestones: Milestone[] }) | null> {
    const db = this.getClient(options);
    const row = await db.contract.findUnique({
      where: { id },
      include: {
        milestones: {
          orderBy: { orderIndex: "asc" },
        },
      },
    });
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      clientId: row.clientId,
      developerId: row.developerId,
      status: row.status as ContractStatus,
      totalAmountMinorUnits: BigInt(row.totalAmountMinorUnits),
      currency: row.currency as SupportedCurrency,
      githubRepoOwner: row.githubRepoOwner,
      githubRepoName: row.githubRepoName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      milestones: row.milestones.map((m) => ({
        id: m.id,
        contractId: m.contractId,
        title: m.title,
        description: m.description,
        orderIndex: m.orderIndex,
        amountMinorUnits: BigInt(m.amountMinorUnits),
        currency: m.currency as SupportedCurrency,
        status: m.status as MilestoneStatus,
        activeCriteriaVersion: m.activeCriteriaVersion,
        fundedAt: m.fundedAt,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    };
  }

  async updateStatus(
    id: string,
    status: ContractStatus,
    options?: ContractRepositoryOptions
  ): Promise<Contract> {
    const db = this.getClient(options);
    const existing = await db.contract.findUnique({ where: { id } });
    if (!existing) {
      throw new DomainNotFoundError("Contract", id);
    }

    const row = await db.contract.update({
      where: { id },
      data: { status },
    });

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      clientId: row.clientId,
      developerId: row.developerId,
      status: row.status as ContractStatus,
      totalAmountMinorUnits: BigInt(row.totalAmountMinorUnits),
      currency: row.currency as SupportedCurrency,
      githubRepoOwner: row.githubRepoOwner,
      githubRepoName: row.githubRepoName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
