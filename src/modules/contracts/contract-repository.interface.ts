/**
 * VeriRelease Contract Repository Interface
 *
 * Defines the contract persistence boundary.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type { SupportedCurrency } from "../common/money";
import type { Contract, ContractStatus, Milestone } from "./types";

export interface CreateContractInput {
  id?: string;
  title: string;
  description: string;
  clientId: string;
  developerId: string;
  totalAmountMinorUnits: bigint;
  currency: SupportedCurrency;
  githubRepoOwner: string;
  githubRepoName: string;
  status?: ContractStatus;
}

export interface ContractRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface ContractRepository {
  /**
   * Creates a new contract with validation.
   */
  create(input: CreateContractInput, options?: ContractRepositoryOptions): Promise<Contract>;

  /**
   * Retrieves a contract by its unique ID.
   */
  findById(id: string, options?: ContractRepositoryOptions): Promise<Contract | null>;

  /**
   * Retrieves a contract by ID along with all associated milestones.
   */
  findByIdWithMilestones(
    id: string,
    options?: ContractRepositoryOptions
  ): Promise<(Contract & { milestones: Milestone[] }) | null>;

  /**
   * Updates contract status.
   */
  updateStatus(
    id: string,
    status: ContractStatus,
    options?: ContractRepositoryOptions
  ): Promise<Contract>;
}
