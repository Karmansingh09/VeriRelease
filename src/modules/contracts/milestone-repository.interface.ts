/**
 * VeriRelease Milestone Repository Interface
 *
 * Defines the milestone and acceptance criteria persistence boundary.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type { SupportedCurrency } from "../common/money";
import type {
  Milestone,
  MilestoneStatus,
  AcceptanceCriterion,
  CriterionType,
} from "./types";

export interface CreateCriterionInput {
  id?: string;
  orderIndex: number;
  title: string;
  description: string;
  criterionType: CriterionType;
  isMandatory?: boolean;
}

export interface CreateMilestoneInput {
  id?: string;
  contractId: string;
  title: string;
  description: string;
  orderIndex: number;
  amountMinorUnits: bigint;
  currency: SupportedCurrency;
  status?: MilestoneStatus;
  criteria?: CreateCriterionInput[];
}

export interface MilestoneRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface MilestoneRepository {
  /**
   * Creates a new milestone, optionally with initial acceptance criteria (version 1).
   */
  create(
    input: CreateMilestoneInput,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone & { criteria: AcceptanceCriterion[] }>;

  /**
   * Retrieves a milestone by its unique ID.
   */
  findById(id: string, options?: MilestoneRepositoryOptions): Promise<Milestone | null>;

  /**
   * Retrieves a milestone along with its acceptance criteria for a given version.
   * If version is omitted, uses the milestone's activeCriteriaVersion.
   */
  findByIdWithCriteria(
    id: string,
    version?: number,
    options?: MilestoneRepositoryOptions
  ): Promise<(Milestone & { criteria: AcceptanceCriterion[] }) | null>;

  /**
   * Retrieves all milestones belonging to a contract, ordered by orderIndex ASC.
   */
  findByContractId(
    contractId: string,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone[]>;

  /**
   * Updates milestone status and optionally records fundedAt timestamp.
   */
  updateStatus(
    id: string,
    status: MilestoneStatus,
    fundedAt?: Date | null,
    options?: MilestoneRepositoryOptions
  ): Promise<Milestone>;

  /**
   * Amends milestone acceptance criteria by incrementing activeCriteriaVersion
   * and inserting new immutable criteria rows with version = N + 1.
   * Historical criteria rows are never modified or deleted.
   */
  amendCriteria(
    milestoneId: string,
    criteria: CreateCriterionInput[],
    options?: MilestoneRepositoryOptions
  ): Promise<{ activeCriteriaVersion: number; criteria: AcceptanceCriterion[] }>;

  /**
   * Acquires a row-level exclusive lock on the milestone row (SELECT ... FOR UPDATE).
   */
  lockForUpdate(id: string, tx: PrismaTransactionClient): Promise<Milestone>;
}
