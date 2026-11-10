/**
 * VeriRelease Payment Reconciliation Service Implementation
 *
 * Implements authoritative resolution for unresolved payment transactions
 * (PAYOUT_UNCERTAIN and RECONCILIATION_REQUIRED) under milestone-first row locks.
 */

import {
  prisma,
  type DbClient,
  type PrismaClient,
  type PrismaTransactionClient,
} from "../../lib/prisma";
import {
  ConcurrencyConflictError,
  DomainNotFoundError,
  DomainValidationError,
  DuplicatePayoutError,
} from "../common/errors";
import type { PaymentRepository } from "./payment-repository.interface";
import { PrismaPaymentRepository } from "./prisma-payment-repository";
import type { ReconciliationRepository } from "./reconciliation-repository.interface";
import { PrismaReconciliationRepository } from "./prisma-reconciliation-repository";
import type { AuditService } from "../audit/audit-service.interface";
import { TransactionalAuditService } from "../audit/audit-service";
import { validatePaymentTransition } from "./payment-state-machine";
import type {
  PaymentReconciliationService,
  PaymentReconciliationServiceOptions,
  ReconcilePaymentInput,
  ReconcilePaymentResult,
} from "./reconciliation-service.interface";
import type {
  PaymentReconciliation,
  PaymentTxStatus,
} from "./types";

export class PaymentReconciliationServiceImpl implements PaymentReconciliationService {
  constructor(
    private readonly paymentRepo: PaymentRepository = new PrismaPaymentRepository(prisma),
    private readonly reconciliationRepo: ReconciliationRepository = new PrismaReconciliationRepository(prisma),
    private readonly auditService: AuditService = new TransactionalAuditService(undefined, prisma),
    private readonly client: DbClient = prisma
  ) {}

  async reconcilePayment(
    input: ReconcilePaymentInput,
    options?: PaymentReconciliationServiceOptions
  ): Promise<ReconcilePaymentResult> {
    // 1. Validate reason
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new DomainValidationError("Reconciliation reason must not be empty");
    }
    const trimmedReason = input.reason.trim();

    // 2. Validate evidenceReference for CONFIRMED_SUCCEEDED and CONFIRMED_FAILED
    const trimmedEvidenceReference =
      typeof input.evidenceReference === "string" ? input.evidenceReference.trim() : null;

    if (input.decision === "CONFIRMED_SUCCEEDED" || input.decision === "CONFIRMED_FAILED") {
      if (!trimmedEvidenceReference || trimmedEvidenceReference.length === 0) {
        throw new DomainValidationError(
          `Reconciliation decision '${input.decision}' requires a non-empty evidenceReference`
        );
      }
    }

    // 3. Validate actor attribution
    const actor = input.actor;
    if (!actor || !actor.actorType) {
      throw new DomainValidationError("Reconciliation requires a valid actor");
    }
    if (actor.actorType === "USER") {
      if (!actor.actorUserId || actor.actorUserId.trim().length === 0) {
        throw new DomainValidationError("USER actor requires a valid non-empty actorUserId");
      }
      if (actor.actorSystemPrincipal && actor.actorSystemPrincipal.trim().length > 0) {
        throw new DomainValidationError("USER actor cannot have an actorSystemPrincipal");
      }
    } else {
      if (!actor.actorSystemPrincipal || actor.actorSystemPrincipal.trim().length === 0) {
        throw new DomainValidationError(
          `Non-USER actor '${actor.actorType}' requires a valid non-empty actorSystemPrincipal`
        );
      }
      if (actor.actorUserId && actor.actorUserId.trim().length > 0) {
        throw new DomainValidationError(
          `Non-USER actor '${actor.actorType}' cannot have an actorUserId`
        );
      }
    }

    // Determine target payment status
    let targetStatus: PaymentTxStatus;
    let auditAction: string;
    if (input.decision === "CONFIRMED_SUCCEEDED") {
      targetStatus = "SUCCEEDED";
      auditAction = "PAYOUT_RECONCILED_SUCCEEDED";
    } else if (input.decision === "CONFIRMED_FAILED") {
      targetStatus = "FAILED";
      auditAction = "PAYOUT_RECONCILED_FAILED";
    } else if (input.decision === "STILL_UNCERTAIN") {
      targetStatus = "RECONCILIATION_REQUIRED";
      auditAction = "PAYOUT_RECONCILIATION_STILL_UNCERTAIN";
    } else {
      throw new DomainValidationError(`Unrecognized reconciliation decision: '${String(input.decision)}'`);
    }

    const runInTx = async (tx: PrismaTransactionClient): Promise<ReconcilePaymentResult> => {
      // 4. Milestone-First Row Lock (when transitioning to SUCCEEDED)
      if (targetStatus === "SUCCEEDED") {
        const milestoneRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM "Milestone"
          WHERE id = ${input.milestoneId}
          FOR UPDATE;
        `;
        if (milestoneRows.length === 0) {
          throw new DomainNotFoundError("Milestone", input.milestoneId);
        }

        // Duplicate successful payout guard
        const existingSucceeded = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "PaymentTransaction"
          WHERE "milestoneId" = ${input.milestoneId}
            AND "transactionType" = 'PAYOUT'
            AND "status" = 'SUCCEEDED'
            AND "id" <> ${input.transactionId}
          LIMIT 1;
        `;
        if (existingSucceeded.length > 0) {
          throw new DuplicatePayoutError(
            `Cannot reconcile payout ${input.transactionId} to SUCCEEDED: milestone ${input.milestoneId} already has a succeeded payout (${existingSucceeded[0]!.id}).`
          );
        }
      }

      // 5. Target PaymentTransaction Row Lock
      const paymentRows = await tx.$queryRaw<Array<{
        id: string;
        milestoneId: string;
        transactionType: string;
        status: PaymentTxStatus;
        idempotencyKey: string;
        attemptNumber: number;
      }>>`
        SELECT id, "milestoneId", "transactionType", status, "idempotencyKey", "attemptNumber"
        FROM "PaymentTransaction"
        WHERE id = ${input.transactionId} AND "milestoneId" = ${input.milestoneId}
        FOR UPDATE;
      `;

      const payment = paymentRows[0];
      if (!payment) {
        throw new DomainNotFoundError("PaymentTransaction", input.transactionId);
      }

      // 6. Validate allowed current status for reconciliation
      if (input.decision === "STILL_UNCERTAIN") {
        if (payment.status !== "PAYOUT_UNCERTAIN") {
          throw new ConcurrencyConflictError(
            `Cannot mark payment ${input.transactionId} as STILL_UNCERTAIN: current status is '${payment.status}', expected 'PAYOUT_UNCERTAIN'.`
          );
        }
      } else {
        // CONFIRMED_SUCCEEDED or CONFIRMED_FAILED
        if (payment.status !== "PAYOUT_UNCERTAIN" && payment.status !== "RECONCILIATION_REQUIRED") {
          throw new ConcurrencyConflictError(
            `Cannot reconcile payment ${input.transactionId} with decision '${input.decision}': current status is '${payment.status}'. Only 'PAYOUT_UNCERTAIN' or 'RECONCILIATION_REQUIRED' can be reconciled.`
          );
        }
      }

      // Validate payment state machine transition
      validatePaymentTransition(payment.status, targetStatus);

      // 7. Update PaymentTransaction
      const updatedTx = await this.paymentRepo.updateStatus(
        input.transactionId,
        input.milestoneId,
        payment.status,
        targetStatus,
        {
          errorMessage: input.decision === "CONFIRMED_FAILED" ? trimmedReason : undefined,
        },
        { tx }
      );

      // 8. Create append-only PaymentReconciliation record
      const reconciliation = await this.reconciliationRepo.createReconciliation(
        {
          paymentTransactionId: input.transactionId,
          decision: input.decision,
          reason: trimmedReason,
          evidenceReference: trimmedEvidenceReference,
          evidenceType: input.evidenceType?.trim() ?? null,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId?.trim() ?? null,
          actorSystemPrincipal: actor.actorSystemPrincipal?.trim() ?? null,
        },
        { tx }
      );

      // 9. Atomic Audit Event
      const correlationId = input.correlationId ?? input.transactionId;
      await this.auditService.recordEvent(
        {
          entityType: "PAYMENT",
          entityId: input.transactionId,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId?.trim() ?? null,
          actorSystemPrincipal: actor.actorSystemPrincipal?.trim() ?? null,
          action: auditAction,
          previousState: { status: payment.status },
          newState: { status: targetStatus },
          metadata: {
            reconciliationId: reconciliation.id,
            decision: input.decision,
            reason: trimmedReason,
            evidenceReference: trimmedEvidenceReference,
            evidenceType: input.evidenceType?.trim() ?? null,
            evidenceVerificationStatus: "SUPPLIED_NOT_VERIFIED",
            attemptNumber: payment.attemptNumber,
            idempotencyKey: payment.idempotencyKey,
          },
          correlationId,
        },
        { tx }
      );

      return {
        transaction: updatedTx,
        reconciliation,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx, {
      isolationLevel: "ReadCommitted",
    });
  }

  async getReconciliation(
    id: string,
    options?: PaymentReconciliationServiceOptions
  ): Promise<PaymentReconciliation | null> {
    return this.reconciliationRepo.findById(id, options);
  }

  async getReconciliationsForTransaction(
    paymentTransactionId: string,
    options?: PaymentReconciliationServiceOptions
  ): Promise<PaymentReconciliation[]> {
    return this.reconciliationRepo.findByPaymentTransactionId(paymentTransactionId, options);
  }
}
