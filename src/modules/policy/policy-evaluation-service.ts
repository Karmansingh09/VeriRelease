/**
 * VeriRelease Policy Evaluation Service Implementation
 *
 * Orchestrates deterministic policy evaluation, persistent PolicyEvaluation records,
 * Milestone state transitions, and append-only audit persistence within database transactions.
 */

import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../lib/prisma";
import { hashCanonicalJson } from "../common/canonical-json";
import { DomainNotFoundError, DomainValidationError } from "../common/errors";
import { transitionMilestone, type MilestoneTransitionResult } from "../contracts/milestone-state-machine";
import type { MilestoneStatus, CriteriaSnapshotItem } from "../contracts/types";
import type { MilestoneRepository } from "../contracts/milestone-repository.interface";
import type { SubmissionRepository } from "../contracts/submission-repository.interface";
import { PrismaMilestoneRepository } from "../contracts/prisma-milestone-repository";
import { PrismaSubmissionRepository } from "../contracts/prisma-submission-repository";
import type { PolicyRepository } from "./policy-repository.interface";
import { PrismaPolicyRepository } from "./prisma-policy-repository";
import { evaluatePolicy, type PolicyEvaluationOutput } from "./policy-evaluator";
import type {
  PolicyService,
  EvaluateSubmissionInput,
  EvaluateSubmissionResult,
  PolicyServiceOptions,
} from "./policy-service.interface";
import type { PolicyEvaluation } from "./types";
import type { AuditService } from "../audit/audit-service.interface";
import { TransactionalAuditService } from "../audit/audit-service";
import { PrismaAuditRepository } from "../audit/prisma-audit-repository";

export class PolicyEvaluationService implements PolicyService {
  private readonly auditService: AuditService;
  private readonly client: DbClient;

  constructor(
    private readonly policyRepo: PolicyRepository = new PrismaPolicyRepository(prisma),
    private readonly milestoneRepo: MilestoneRepository = new PrismaMilestoneRepository(prisma),
    private readonly submissionRepo: SubmissionRepository = new PrismaSubmissionRepository(prisma),
    auditServiceOrClient?: AuditService | DbClient,
    client: DbClient = prisma
  ) {
    if (auditServiceOrClient && "recordEvent" in auditServiceOrClient) {
      this.auditService = auditServiceOrClient;
      this.client = client;
    } else {
      this.client = (auditServiceOrClient as DbClient) ?? client;
      this.auditService = new TransactionalAuditService(
        new PrismaAuditRepository(this.client),
        this.client
      );
    }
  }

  async evaluateSubmission(
    input: EvaluateSubmissionInput,
    options?: PolicyServiceOptions
  ): Promise<EvaluateSubmissionResult> {
    const runInTx = async (tx: PrismaTransactionClient): Promise<EvaluateSubmissionResult> => {
      // 1. Look up submission to obtain milestoneId and criteria snapshot
      const submission = await tx.milestoneSubmission.findUnique({
        where: { id: input.submissionId },
      });

      if (!submission) {
        throw new DomainNotFoundError("MilestoneSubmission", input.submissionId);
      }

      // 2. Acquire exclusive FOR UPDATE lock on the parent Milestone (hierarchical lock order)
      const lockedMilestones = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          activeCriteriaVersion: number;
          amountMinorUnits: bigint;
        }>
      >`SELECT id, status, "activeCriteriaVersion", "amountMinorUnits" FROM "Milestone" WHERE id = ${submission.milestoneId} FOR UPDATE;`;

      if (!lockedMilestones || lockedMilestones.length === 0) {
        throw new DomainNotFoundError("Milestone", submission.milestoneId);
      }

      const lockedMilestone = lockedMilestones[0]!;
      const milestoneAmountMinorUnits = BigInt(lockedMilestone.amountMinorUnits);

      // 3. Milestone State Machine Validation
      // If currently SUBMITTED, transition to EVALUATING first
      let currentMilestoneStatus = lockedMilestone.status as MilestoneStatus;
      if (currentMilestoneStatus === "SUBMITTED") {
        const startTransition = transitionMilestone({
          milestone: {
            id: lockedMilestone.id,
            status: "SUBMITTED",
            amountMinorUnits: milestoneAmountMinorUnits,
          },
          targetStatus: "EVALUATING",
          actor: "SYSTEM",
        });

        await this.milestoneRepo.updateStatus(
          lockedMilestone.id,
          "EVALUATING",
          undefined,
          { tx }
        );

        // Persist EVALUATION_STARTED audit event within the same transaction
        await this.auditService.recordEvent(
          {
            entityType: "MILESTONE",
            entityId: lockedMilestone.id,
            actorType: "SYSTEM",
            actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
            action: startTransition.auditAction,
            previousState: { status: "SUBMITTED" },
            newState: { status: "EVALUATING" },
            metadata: {
              submissionId: submission.id,
              criteriaHash: submission.criteriaHash,
            },
            correlationId: submission.id,
          },
          { tx }
        );

        currentMilestoneStatus = "EVALUATING";
      } else if (currentMilestoneStatus !== "EVALUATING") {
        // Any other milestone status (DRAFT, FUNDED, CHANGES_REQUESTED, ELIGIBLE_FOR_PAYOUT, DISPUTED, CANCELLED)
        // is rejected by transitionMilestone with InvalidStateTransitionError
        transitionMilestone({
          milestone: {
            id: lockedMilestone.id,
            status: currentMilestoneStatus,
            amountMinorUnits: milestoneAmountMinorUnits,
          },
          targetStatus: "EVALUATING",
          actor: "SYSTEM",
        });
      }

      // 4. Verify snapshot and criteriaHash consistency
      const criteriaSnapshot = submission.criteriaSnapshot as unknown as readonly CriteriaSnapshotItem[];
      if (!criteriaSnapshot || !Array.isArray(criteriaSnapshot) || criteriaSnapshot.length === 0) {
        throw new DomainValidationError(
          `Cannot evaluate submission '${submission.id}': criteria snapshot is empty or invalid`
        );
      }

      const recomputedHash = hashCanonicalJson(criteriaSnapshot);
      if (recomputedHash !== submission.criteriaHash) {
        throw new DomainValidationError(
          `Criteria hash tampering detected on submission '${submission.id}': snapshot canonical hash '${recomputedHash}' does not match recorded hash '${submission.criteriaHash}'`
        );
      }

      // 5. Pure deterministic policy evaluation
      const evalOutput: PolicyEvaluationOutput = evaluatePolicy(
        criteriaSnapshot,
        input.assessments
      );

      // 6. Create IN_PROGRESS policy evaluation record (locks MilestoneSubmission & allocates sequential number)
      const inProgressEval = await this.policyRepo.createEvaluation(
        {
          submissionId: submission.id,
          milestoneId: submission.milestoneId,
          criteriaHash: submission.criteriaHash,
          policyVersion: input.policyVersion ?? "1.0.0",
        },
        { tx }
      );

      // 7. Authoritative receipt hash must always be computed internally from validated evaluation data
      const authoritativeReceiptHash = hashCanonicalJson({
        submissionId: submission.id,
        milestoneId: submission.milestoneId,
        criteriaHash: submission.criteriaHash,
        evaluationNumber: inProgressEval.evaluationNumber,
        decision: evalOutput.decision,
        evaluations: evalOutput.evaluations,
      });

      // If caller supplied a receiptHash, verify it matches the authoritative computed hash exactly
      if (input.receiptHash !== undefined && input.receiptHash !== null) {
        if (input.receiptHash !== authoritativeReceiptHash) {
          throw new DomainValidationError(
            `Receipt hash mismatch: caller-supplied receiptHash '${input.receiptHash}' does not match authoritative computed receiptHash '${authoritativeReceiptHash}'`
          );
        }
      }

      // Persist strictly the internally computed authoritative receipt hash
      const receiptHash = authoritativeReceiptHash;

      // 8. Finalize and complete policy evaluation (persists completed outcome; trigger prevents subsequent modification)
      const completedEval = await this.policyRepo.updateEvaluation(
        inProgressEval.id,
        {
          status: "COMPLETED",
          decision: evalOutput.decision,
          decisionReason: evalOutput.decisionReason,
          evaluations: evalOutput.evaluations,
          receiptHash,
          completedAt: new Date(),
        },
        { tx }
      );

      // 9. Milestone Transition based on deterministic outcome
      const targetStatus: MilestoneStatus =
        evalOutput.decision === "PASS"
          ? "ELIGIBLE_FOR_PAYOUT"
          : "CHANGES_REQUESTED";

      const transitionResult: MilestoneTransitionResult = transitionMilestone({
        milestone: {
          id: lockedMilestone.id,
          status: "EVALUATING",
          amountMinorUnits: milestoneAmountMinorUnits,
        },
        targetStatus,
        actor: "SYSTEM",
      });

      const updatedMilestone = await this.milestoneRepo.updateStatus(
        lockedMilestone.id,
        targetStatus,
        undefined,
        { tx }
      );

      // Persist POLICY_EVALUATION_APPROVED or CHANGES_REQUESTED audit event within the same transaction
      await this.auditService.recordEvent(
        {
          entityType: "MILESTONE",
          entityId: lockedMilestone.id,
          actorType: "SYSTEM",
          actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
          action: transitionResult.auditAction,
          previousState: { status: "EVALUATING" },
          newState: { status: targetStatus },
          metadata: {
            submissionId: submission.id,
            evaluationId: completedEval.id,
            decision: evalOutput.decision,
            receiptHash,
          },
          correlationId: submission.id,
        },
        { tx }
      );

      return {
        evaluation: completedEval,
        milestone: updatedMilestone,
        evaluationResult: evalOutput,
        transitionResult,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx, {
      isolationLevel: "ReadCommitted",
    });
  }

  async getEvaluationsForSubmission(
    submissionId: string,
    options?: PolicyServiceOptions
  ): Promise<PolicyEvaluation[]> {
    return this.policyRepo.findBySubmissionId(submissionId, options);
  }

  async getLatestEvaluation(
    submissionId: string,
    options?: PolicyServiceOptions
  ): Promise<PolicyEvaluation | null> {
    return this.policyRepo.findLatestBySubmissionId(submissionId, options);
  }
}
