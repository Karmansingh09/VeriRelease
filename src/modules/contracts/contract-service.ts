/**
 * VeriRelease Contract & Milestone Lifecycle Service
 *
 * Orchestrates contract creation, milestone addition, developer assignment,
 * milestone funding, work submission, change requests, and transactional audit logging.
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient } from "../../lib/prisma";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
} from "../common/errors";
import { parseMajorToMinor, type SupportedCurrency } from "../common/money";
import type { DefaultAuditService } from "../audit";
import type { ContractRepository } from "./contract-repository.interface";
import type {
  MilestoneRepository,
  CreateCriterionInput,
} from "./milestone-repository.interface";
import type { SubmissionRepository } from "./submission-repository.interface";
import type {
  Contract,
  ContractStatus,
  Milestone,
  MilestoneStatus,
  MilestoneSubmission,
  AcceptanceCriterion,
  CriterionType,
  CriteriaSnapshotItem,
  SubmissionStatus,
} from "./types";
import { transitionMilestone } from "./milestone-state-machine";

export interface CreateContractDto {
  title: string;
  description: string;
  developerId?: string;
  developerEmail?: string;
  developerGithubUsername?: string;
  totalAmountMinorUnits?: bigint | string | number;
  totalAmountUsd?: string | number;
  currency?: SupportedCurrency;
  githubRepoOwner: string;
  githubRepoName: string;
}

export interface CreateMilestoneDto {
  title: string;
  description: string;
  orderIndex?: number;
  amountMinorUnits?: bigint | string | number;
  amountUsd?: string | number;
  currency?: SupportedCurrency;
  criteria?: Array<{
    title: string;
    description: string;
    criterionType: CriterionType;
    isMandatory?: boolean;
    orderIndex?: number;
  }>;
}

export interface SubmitMilestoneDto {
  prNumber: number;
  prCommitSha: string;
  prUrl: string;
}

export interface ContractParticipantSummary {
  id: string;
  email: string;
  name: string;
  role: string;
  githubUsername: string | null;
}

export interface ContractWithDetails extends Contract {
  client: ContractParticipantSummary;
  developer: ContractParticipantSummary;
  milestones: Array<
    Milestone & {
      criteriaCount: number;
      latestSubmissionStatus: string | null;
      latestPrNumber: number | null;
    }
  >;
}

export interface MilestoneDetailView extends Milestone {
  contract: Contract & {
    client: ContractParticipantSummary;
    developer: ContractParticipantSummary;
  };
  criteria: AcceptanceCriterion[];
  submissions: MilestoneSubmission[];
  auditTimeline: Array<{
    id: string;
    action: string;
    actorType: string;
    actorUserId: string | null;
    timestamp: Date;
    metadata: Record<string, unknown> | null;
  }>;
}

export class ContractService {
  constructor(
    private readonly contractRepo: ContractRepository,
    private readonly milestoneRepo: MilestoneRepository,
    private readonly submissionRepo: SubmissionRepository,
    private readonly auditService: DefaultAuditService,
    private readonly client: DbClient = prisma
  ) {}

  /**
   * Creates a new contract with an assigned developer and emits an audit event.
   */
  async createContract(
    callerId: string,
    dto: CreateContractDto
  ): Promise<Contract> {
    // 1. Verify caller user exists and is active
    const caller = await this.client.user.findUnique({
      where: { id: callerId },
    });
    if (!caller || !caller.isActive) {
      throw new DomainForbiddenError("Caller user is inactive or does not exist");
    }

    // 2. Resolve developer
    let developerId = dto.developerId;
    if (!developerId && dto.developerEmail) {
      const devByEmail = await this.client.user.findUnique({
        where: { email: dto.developerEmail.trim().toLowerCase() },
      });
      if (devByEmail) {
        developerId = devByEmail.id;
      } else {
        // Auto-provision developer account stub if email provided
        const newDevId = `usr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const namePart = dto.developerEmail.split("@")[0] ?? "Developer";
        const createdDev = await this.client.user.create({
          data: {
            id: newDevId,
            email: dto.developerEmail.trim().toLowerCase(),
            name: namePart.charAt(0).toUpperCase() + namePart.slice(1),
            role: "DEVELOPER",
            githubUsername: dto.developerGithubUsername?.trim() ?? null,
            isActive: true,
          },
        });
        developerId = createdDev.id;
      }
    } else if (!developerId && dto.developerGithubUsername) {
      const devByGithub = await this.client.user.findFirst({
        where: { githubUsername: dto.developerGithubUsername.trim() },
      });
      if (devByGithub) {
        developerId = devByGithub.id;
      }
    }

    if (!developerId) {
      throw new DomainValidationError(
        "A valid developer (developerId, developerEmail, or developerGithubUsername) must be specified"
      );
    }

    if (callerId === developerId) {
      throw new DomainValidationError(
        "Contract client and developer must be distinct users"
      );
    }

    // Verify developer exists
    const developer = await this.client.user.findUnique({
      where: { id: developerId },
    });
    if (!developer || !developer.isActive) {
      throw new DomainNotFoundError("User", developerId);
    }

    // Calculate total amount in minor units
    let totalAmountMinorUnits = 100000n; // Default $1000.00
    if (dto.totalAmountMinorUnits !== undefined) {
      totalAmountMinorUnits = BigInt(dto.totalAmountMinorUnits);
    } else if (dto.totalAmountUsd !== undefined) {
      totalAmountMinorUnits = parseMajorToMinor(String(dto.totalAmountUsd), dto.currency ?? "USD");
    }

    const currency: SupportedCurrency = dto.currency ?? "USD";

    const contract = await this.contractRepo.create({
      title: dto.title.trim(),
      description: dto.description.trim(),
      clientId: callerId,
      developerId,
      totalAmountMinorUnits,
      currency,
      githubRepoOwner: dto.githubRepoOwner.trim(),
      githubRepoName: dto.githubRepoName.trim(),
      status: "DRAFT",
    });

    // Record audit event
    await this.auditService.recordEvent({
      entityType: "CONTRACT",
      entityId: contract.id,
      actorType: "USER",
      actorUserId: callerId,
      action: "CONTRACT_CREATED",
      metadata: {
        title: contract.title,
        clientId: contract.clientId,
        developerId: contract.developerId,
        totalAmountMinorUnits: contract.totalAmountMinorUnits.toString(),
        currency: contract.currency,
        githubRepo: `${contract.githubRepoOwner}/${contract.githubRepoName}`,
      },
      correlationId: `corr_cnt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });

    return contract;
  }

  /**
   * Retrieves all contracts where the caller is either client or developer.
   */
  async getContractsForUser(
    callerId: string,
    filterRole?: "CLIENT" | "DEVELOPER"
  ): Promise<ContractWithDetails[]> {
    const contracts = await this.client.contract.findMany({
      where: {
        OR: [{ clientId: callerId }, { developerId: callerId }],
        ...(filterRole === "CLIENT" ? { clientId: callerId } : {}),
        ...(filterRole === "DEVELOPER" ? { developerId: callerId } : {}),
      },
      include: {
        client: {
          select: { id: true, email: true, name: true, role: true, githubUsername: true },
        },
        developer: {
          select: { id: true, email: true, name: true, role: true, githubUsername: true },
        },
        milestones: {
          orderBy: { orderIndex: "asc" },
          include: {
            criteria: { select: { id: true } },
            submissions: {
              orderBy: { submissionNumber: "desc" },
              take: 1,
              select: { status: true, prNumber: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return contracts.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      clientId: c.clientId,
      developerId: c.developerId,
      status: c.status as ContractStatus,
      totalAmountMinorUnits: BigInt(c.totalAmountMinorUnits),
      currency: c.currency as SupportedCurrency,
      githubRepoOwner: c.githubRepoOwner,
      githubRepoName: c.githubRepoName,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      client: c.client,
      developer: c.developer,
      milestones: c.milestones.map((m) => ({
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
        criteriaCount: m.criteria.length,
        latestSubmissionStatus: m.submissions[0]?.status ?? null,
        latestPrNumber: m.submissions[0]?.prNumber ?? null,
      })),
    }));
  }

  /**
   * Retrieves single contract by ID with full details if caller is authorized.
   */
  async getContractById(
    contractId: string,
    callerId: string
  ): Promise<ContractWithDetails> {
    const c = await this.client.contract.findUnique({
      where: { id: contractId },
      include: {
        client: {
          select: { id: true, email: true, name: true, role: true, githubUsername: true },
        },
        developer: {
          select: { id: true, email: true, name: true, role: true, githubUsername: true },
        },
        milestones: {
          orderBy: { orderIndex: "asc" },
          include: {
            criteria: { select: { id: true } },
            submissions: {
              orderBy: { submissionNumber: "desc" },
              take: 1,
              select: { status: true, prNumber: true },
            },
          },
        },
      },
    });

    if (!c) {
      throw new DomainNotFoundError("Contract", contractId);
    }

    // Enforce authorization
    if (c.clientId !== callerId && c.developerId !== callerId) {
      const callerUser = await this.client.user.findUnique({ where: { id: callerId } });
      if (callerUser?.role !== "ADMIN") {
        throw new DomainForbiddenError("You are not authorized to view this contract");
      }
    }

    return {
      id: c.id,
      title: c.title,
      description: c.description,
      clientId: c.clientId,
      developerId: c.developerId,
      status: c.status as ContractStatus,
      totalAmountMinorUnits: BigInt(c.totalAmountMinorUnits),
      currency: c.currency as SupportedCurrency,
      githubRepoOwner: c.githubRepoOwner,
      githubRepoName: c.githubRepoName,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      client: c.client,
      developer: c.developer,
      milestones: c.milestones.map((m) => ({
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
        criteriaCount: m.criteria.length,
        latestSubmissionStatus: m.submissions[0]?.status ?? null,
        latestPrNumber: m.submissions[0]?.prNumber ?? null,
      })),
    };
  }

  /**
   * Adds a milestone to a contract with acceptance criteria.
   * Only the contract's client may add milestones.
   */
  async addMilestone(
    contractId: string,
    callerId: string,
    dto: CreateMilestoneDto
  ): Promise<Milestone & { criteria: AcceptanceCriterion[] }> {
    const contract = await this.client.contract.findUnique({
      where: { id: contractId },
      include: { milestones: { select: { orderIndex: true } } },
    });

    if (!contract) {
      throw new DomainNotFoundError("Contract", contractId);
    }

    if (contract.clientId !== callerId) {
      throw new DomainForbiddenError("Only the contract client can add milestones");
    }

    if (contract.status === "COMPLETED" || contract.status === "CANCELLED") {
      throw new DomainConflictError(
        `Cannot add milestones to a contract in '${contract.status}' status`
      );
    }

    // Determine orderIndex
    let orderIndex = dto.orderIndex;
    if (orderIndex === undefined || orderIndex <= 0) {
      const maxOrder = contract.milestones.reduce(
        (max, m) => (m.orderIndex > max ? m.orderIndex : max),
        0
      );
      orderIndex = maxOrder + 1;
    }

    // Determine amount
    let amountMinorUnits = 50000n; // Default $500.00
    if (dto.amountMinorUnits !== undefined) {
      amountMinorUnits = BigInt(dto.amountMinorUnits);
    } else if (dto.amountUsd !== undefined) {
      amountMinorUnits = parseMajorToMinor(String(dto.amountUsd), contract.currency as SupportedCurrency);
    }

    const currency = (dto.currency ?? contract.currency) as SupportedCurrency;

    // Format criteria
    const criteriaInputs: CreateCriterionInput[] = (dto.criteria ?? []).map(
      (c, idx) => ({
        orderIndex: c.orderIndex ?? idx + 1,
        title: c.title.trim(),
        description: c.description.trim(),
        criterionType: c.criterionType,
        isMandatory: c.isMandatory ?? true,
      })
    );

    const milestone = await this.milestoneRepo.create({
      contractId,
      title: dto.title.trim(),
      description: dto.description.trim(),
      orderIndex,
      amountMinorUnits,
      currency,
      criteria: criteriaInputs,
    });

    // Record audit event
    await this.auditService.recordEvent({
      entityType: "MILESTONE",
      entityId: milestone.id,
      actorType: "USER",
      actorUserId: callerId,
      action: "MILESTONE_CREATED",
      metadata: {
        contractId,
        title: milestone.title,
        orderIndex: milestone.orderIndex,
        amountMinorUnits: milestone.amountMinorUnits.toString(),
        currency: milestone.currency,
        criteriaCount: milestone.criteria.length,
      },
      correlationId: `corr_mls_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });

    return milestone;
  }

  /**
   * Funds a milestone (transitions DRAFT -> FUNDED).
   * Only the contract's client may fund a milestone.
   */
  async fundMilestone(
    milestoneId: string,
    callerId: string
  ): Promise<Milestone> {
    const milestone = await this.client.milestone.findUnique({
      where: { id: milestoneId },
      include: { contract: true },
    });

    if (!milestone) {
      throw new DomainNotFoundError("Milestone", milestoneId);
    }

    if (milestone.contract.clientId !== callerId) {
      throw new DomainForbiddenError("Only the contract client can fund milestones");
    }

    // Query active criteria count from database
    const activeCriteriaCount = await this.client.acceptanceCriterion.count({
      where: {
        milestoneId: milestone.id,
        version: milestone.activeCriteriaVersion,
      },
    });

    if (activeCriteriaCount <= 0) {
      throw new DomainValidationError(
        "Cannot fund milestone: at least one acceptance criterion is required before funding"
      );
    }

    // State machine check
    transitionMilestone({
      milestone: {
        id: milestone.id,
        status: milestone.status as MilestoneStatus,
        amountMinorUnits: BigInt(milestone.amountMinorUnits),
      },
      targetStatus: "FUNDED",
      actor: "CLIENT",
      activeCriteriaCount,
    });

    const updated = await this.milestoneRepo.updateStatus(
      milestoneId,
      "FUNDED",
      new Date()
    );

    // If contract was DRAFT, activate it
    if (milestone.contract.status === "DRAFT") {
      await this.contractRepo.updateStatus(milestone.contract.id, "ACTIVE");
    }

    // Record audit event
    await this.auditService.recordEvent({
      entityType: "MILESTONE",
      entityId: milestoneId,
      actorType: "USER",
      actorUserId: callerId,
      action: "MILESTONE_FUNDED",
      previousState: { status: milestone.status },
      newState: { status: "FUNDED" },
      metadata: {
        contractId: milestone.contractId,
        fundedAt: new Date().toISOString(),
      },
      correlationId: `corr_fund_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });

    return updated;
  }

  /**
   * Submits deliverable work for a milestone by associating a GitHub PR.
   * Only the assigned developer can submit work.
   */
  async submitMilestoneWork(
    milestoneId: string,
    callerId: string,
    dto: SubmitMilestoneDto
  ): Promise<MilestoneSubmission> {
    if (dto.prUrl.includes("/issues/")) {
      throw new DomainValidationError("Pull request URL cannot be an issues URL");
    }

    const milestone = await this.client.milestone.findUnique({
      where: { id: milestoneId },
      include: { contract: true },
    });

    if (!milestone) {
      throw new DomainNotFoundError("Milestone", milestoneId);
    }

    if (milestone.contract.developerId !== callerId) {
      throw new DomainForbiddenError("Only the assigned developer can submit work for this milestone");
    }

    const submission = await this.submissionRepo.createSubmission({
      milestoneId,
      prNumber: dto.prNumber,
      prCommitSha: dto.prCommitSha.toLowerCase().trim(),
      prUrl: dto.prUrl.trim(),
      submittedById: callerId,
    });

    const isResubmission = submission.submissionNumber > 1;

    // Record audit event
    await this.auditService.recordEvent({
      entityType: "SUBMISSION",
      entityId: submission.id,
      actorType: "USER",
      actorUserId: callerId,
      action: isResubmission ? "MILESTONE_RESUBMITTED" : "MILESTONE_SUBMITTED",
      metadata: {
        milestoneId,
        contractId: milestone.contractId,
        submissionNumber: submission.submissionNumber,
        prNumber: submission.prNumber,
        prCommitSha: submission.prCommitSha,
        prUrl: submission.prUrl,
        criteriaHash: submission.criteriaHash,
      },
      correlationId: `corr_sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });

    return submission;
  }

  /**
   * Requests changes on a submitted milestone (transitions SUBMITTED/EVALUATING -> CHANGES_REQUESTED).
   * Only the client or an authorized system/admin actor can request changes.
   */
  async requestChanges(
    milestoneId: string,
    callerId: string,
    reason: string
  ): Promise<Milestone> {
    const milestone = await this.client.milestone.findUnique({
      where: { id: milestoneId },
      include: { contract: true },
    });

    if (!milestone) {
      throw new DomainNotFoundError("Milestone", milestoneId);
    }

    if (milestone.contract.clientId !== callerId) {
      const callerUser = await this.client.user.findUnique({ where: { id: callerId } });
      if (callerUser?.role !== "ADMIN") {
        throw new DomainForbiddenError("Only the contract client can request changes on this milestone");
      }
    }

    if (
      milestone.status !== "SUBMITTED" &&
      milestone.status !== "EVALUATING"
    ) {
      throw new DomainConflictError(
        `Cannot request changes on a milestone with status '${milestone.status}'`
      );
    }

    const updated = await this.milestoneRepo.updateStatus(
      milestoneId,
      "CHANGES_REQUESTED"
    );

    // Record audit event
    await this.auditService.recordEvent({
      entityType: "MILESTONE",
      entityId: milestoneId,
      actorType: "USER",
      actorUserId: callerId,
      action: "CHANGES_REQUESTED",
      previousState: { status: milestone.status },
      newState: { status: "CHANGES_REQUESTED" },
      metadata: {
        contractId: milestone.contractId,
        reason: reason.trim(),
      },
      correlationId: `corr_chg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });

    return updated;
  }

  /**
   * Retrieves single milestone detail view including criteria, submissions, and audit trail.
   */
  async getMilestoneDetails(
    milestoneId: string,
    callerId: string
  ): Promise<MilestoneDetailView> {
    const m = await this.client.milestone.findUnique({
      where: { id: milestoneId },
      include: {
        contract: {
          include: {
            client: {
              select: { id: true, email: true, name: true, role: true, githubUsername: true },
            },
            developer: {
              select: { id: true, email: true, name: true, role: true, githubUsername: true },
            },
          },
        },
        criteria: {
          orderBy: { orderIndex: "asc" },
        },
        submissions: {
          orderBy: { submissionNumber: "desc" },
          include: {
            evidenceSnapshots: {
              orderBy: { snapshotVersion: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    if (!m) {
      throw new DomainNotFoundError("Milestone", milestoneId);
    }

    // Authorize caller
    if (m.contract.clientId !== callerId && m.contract.developerId !== callerId) {
      const callerUser = await this.client.user.findUnique({ where: { id: callerId } });
      if (callerUser?.role !== "ADMIN") {
        throw new DomainForbiddenError("You are not authorized to view this milestone");
      }
    }

    // Fetch audit timeline for this milestone
    const auditLogs = await this.client.auditLog.findMany({
      where: {
        OR: [
          { entityType: "MILESTONE", entityId: milestoneId },
          { entityType: "SUBMISSION", entityId: { in: m.submissions.map((s) => s.id) } },
        ],
      },
      orderBy: { timestamp: "desc" },
      take: 50,
      select: {
        id: true,
        action: true,
        actorType: true,
        actorUserId: true,
        timestamp: true,
        metadata: true,
      },
    });

    return {
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
      contract: {
        id: m.contract.id,
        title: m.contract.title,
        description: m.contract.description,
        clientId: m.contract.clientId,
        developerId: m.contract.developerId,
        status: m.contract.status as ContractStatus,
        totalAmountMinorUnits: BigInt(m.contract.totalAmountMinorUnits),
        currency: m.contract.currency as SupportedCurrency,
        githubRepoOwner: m.contract.githubRepoOwner,
        githubRepoName: m.contract.githubRepoName,
        createdAt: m.contract.createdAt,
        updatedAt: m.contract.updatedAt,
        client: m.contract.client,
        developer: m.contract.developer,
      },
      criteria: m.criteria.map((c) => ({
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
      submissions: m.submissions.map((s) => {
        const latestEvidence = s.evidenceSnapshots?.[0] ?? null;
        const verifiedPrUrl = latestEvidence ? latestEvidence.prUrl : null;
        return {
          id: s.id,
          milestoneId: s.milestoneId,
          submissionNumber: s.submissionNumber,
          prNumber: s.prNumber,
          prCommitSha: s.prCommitSha,
          prUrl: s.prUrl,
          verifiedPrUrl,
          isVerified: Boolean(verifiedPrUrl),
          criteriaVersion: s.criteriaVersion,
          criteriaSnapshot: s.criteriaSnapshot as unknown as CriteriaSnapshotItem[],
          criteriaHash: s.criteriaHash,
          status: s.status as SubmissionStatus,
          submittedById: s.submittedById,
          submittedAt: s.submittedAt,
        };
      }),
      auditTimeline: auditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        actorType: log.actorType,
        actorUserId: log.actorUserId,
        timestamp: log.timestamp,
        metadata: log.metadata as Record<string, unknown> | null,
      })),
    };
  }

  /**
   * Lists developers or active users for assigning to contracts.
   */
  async listPotentialDevelopers(query?: string) {
    const users = await this.client.user.findMany({
      where: {
        isActive: true,
        ...(query
          ? {
              OR: [
                { email: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
                { githubUsername: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        githubUsername: true,
      },
      take: 20,
    });
    return users;
  }
}
