/**
 * VeriRelease Payment Service Implementation
 *
 * Coordinates short-lived payment reservations, idempotency enforcement,
 * processing claims, and atomic state transitions under milestone-first row locks.
 */

import {
  prisma,
  type DbClient,
  type PrismaClient,
  type PrismaTransactionClient,
} from "../../lib/prisma";
import {
  assertSupportedCurrency,
  validatePositiveAmount,
  type SupportedCurrency,
} from "../common/money";
import {
  ConcurrencyConflictError,
  DomainNotFoundError,
  DomainValidationError,
  DuplicatePayoutError,
} from "../common/errors";
import type { PaymentRepository } from "./payment-repository.interface";
import { PrismaPaymentRepository } from "./prisma-payment-repository";
import type { AuditService } from "../audit/audit-service.interface";
import { TransactionalAuditService } from "../audit/audit-service";
import {
  generatePayoutIdempotencyKey,
  isValidIdempotencyKey,
  extractPersistedRecipient,
  type PayoutIdempotencyPayload,
} from "./idempotency";
import { validatePaymentTransition } from "./payment-state-machine";
import type {
  PaymentService,
  ReservePayoutInput,
  ReservePayoutResult,
  ClaimProcessingInput,
  TransitionPaymentStatusInput,
  PaymentServiceOptions,
} from "./payment-service.interface";
import type { PaymentTransaction, PaymentTxStatus } from "./types";

export class PaymentCoordinatorService implements PaymentService {
  constructor(
    private readonly paymentRepo: PaymentRepository = new PrismaPaymentRepository(prisma),
    private readonly auditService: AuditService = new TransactionalAuditService(undefined, prisma),
    private readonly client: DbClient = prisma
  ) {}

  async reservePayout(
    input: ReservePayoutInput,
    options?: PaymentServiceOptions
  ): Promise<ReservePayoutResult> {
    const runInTx = async (tx: PrismaTransactionClient): Promise<ReservePayoutResult> => {
      // 1. Explicit milestone-first row lock
      const milestones = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        amountMinorUnits: bigint;
        currency: string;
      }>>`
        SELECT id, status, "amountMinorUnits", currency
        FROM "Milestone"
        WHERE id = ${input.milestoneId}
        FOR UPDATE;
      `;

      const milestone = milestones[0];
      if (!milestone) {
        throw new DomainNotFoundError("Milestone", input.milestoneId);
      }

      // 2. Validate Milestone eligibility
      if (milestone.status !== "ELIGIBLE_FOR_PAYOUT") {
        throw new ConcurrencyConflictError(
          `Milestone ${input.milestoneId} is in status '${milestone.status}'. Only 'ELIGIBLE_FOR_PAYOUT' milestones can be reserved for payment.`
        );
      }

      // 3. Amount and currency validation
      assertSupportedCurrency(milestone.currency);
      const milestoneAmountMinorUnits = BigInt(milestone.amountMinorUnits);
      validatePositiveAmount(milestoneAmountMinorUnits, "Milestone amountMinorUnits");

      if (input.amountMinorUnits !== undefined) {
        const callerAmount = BigInt(input.amountMinorUnits);
        if (callerAmount !== milestoneAmountMinorUnits) {
          throw new DomainValidationError(
            `Amount mismatch: caller specified '${callerAmount}' minor units, but milestone requires '${milestoneAmountMinorUnits}'`
          );
        }
      }

      if (input.currency !== undefined) {
        assertSupportedCurrency(input.currency);
        if (input.currency !== milestone.currency) {
          throw new DomainValidationError(
            `Currency mismatch: caller specified '${input.currency}', but milestone requires '${milestone.currency}'`
          );
        }
      }

      if (!input.developerPayPalEmail || input.developerPayPalEmail.trim() === "") {
        throw new DomainValidationError(
          "Recipient developerPayPalEmail is required for payout reservation"
        );
      }
      const normalizedRecipient = input.developerPayPalEmail.trim().toLowerCase();

      // 4. Succeeded Payout Guard (Defense-in-depth before attempt allocation)
      const existingSucceeded = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "PaymentTransaction"
        WHERE "milestoneId" = ${input.milestoneId}
          AND "transactionType" = 'PAYOUT'
          AND "status" = 'SUCCEEDED'
        LIMIT 1;
      `;
      if (existingSucceeded.length > 0) {
        throw new DuplicatePayoutError(
          `Milestone ${input.milestoneId} already has a succeeded payout (id: ${existingSucceeded[0]!.id}). No further payouts are permitted.`
        );
      }

      // 5. Retrieve authoritative LATEST submission
      const submissions = await tx.$queryRaw<Array<{
        id: string;
        criteriaHash: string;
        submissionNumber: number;
      }>>`
        SELECT id, "criteriaHash", "submissionNumber"
        FROM "MilestoneSubmission"
        WHERE "milestoneId" = ${input.milestoneId}
        ORDER BY "submissionNumber" DESC
        LIMIT 1;
      `;

      const latestSubmission = submissions[0];
      if (!latestSubmission) {
        throw new DomainValidationError(
          `No submission found for milestone ${input.milestoneId}`
        );
      }

      // If caller provided submissionId assertion, verify exact match
      if (input.submissionId && input.submissionId !== latestSubmission.id) {
        throw new ConcurrencyConflictError(
          `Specified submission '${input.submissionId}' is not the authoritative latest submission for milestone '${input.milestoneId}' (latest: '${latestSubmission.id}')`
        );
      }

      // 6. Retrieve authoritative LATEST PolicyEvaluation by evaluationNumber (any status), then validate it.
      // CRITICAL: Do NOT pre-filter by status = 'COMPLETED' before ordering!
      const policyEvaluations = await tx.$queryRaw<Array<{
        id: string;
        decision: string | null;
        status: string;
        criteriaHash: string;
      }>>`
        SELECT id, decision, status, "criteriaHash"
        FROM "PolicyEvaluation"
        WHERE "submissionId" = ${latestSubmission.id}
        ORDER BY "evaluationNumber" DESC
        LIMIT 1;
      `;

      const authoritativeEvaluation = policyEvaluations[0];
      if (!authoritativeEvaluation) {
        throw new DomainValidationError(
          `No policy evaluation found for submission ${latestSubmission.id}.`
        );
      }

      if (authoritativeEvaluation.status !== "COMPLETED") {
        throw new ConcurrencyConflictError(
          `Latest policy evaluation for submission ${latestSubmission.id} is still '${authoritativeEvaluation.status}'. Payout cannot be reserved until evaluation completes.`
        );
      }

      if (authoritativeEvaluation.decision !== "PASS") {
        throw new ConcurrencyConflictError(
          `Latest policy evaluation for submission ${latestSubmission.id} has decision '${authoritativeEvaluation.decision}'. Only a PASS decision authorizes payout.`
        );
      }

      // 7. Hash Consistency Invariant
      if (latestSubmission.criteriaHash !== authoritativeEvaluation.criteriaHash) {
        throw new ConcurrencyConflictError(
          `Internal data integrity violation: submission criteriaHash (${latestSubmission.criteriaHash}) does not match evaluation criteriaHash (${authoritativeEvaluation.criteriaHash}).`
        );
      }

      if (input.expectedCriteriaHash && input.expectedCriteriaHash !== latestSubmission.criteriaHash) {
        throw new ConcurrencyConflictError(
          `Caller criteria hash assertion failed. Stored: ${latestSubmission.criteriaHash}, Provided: ${input.expectedCriteriaHash}`
        );
      }

      // 8. Idempotency Check
      if (input.idempotencyKey !== undefined) {
        if (!isValidIdempotencyKey(input.idempotencyKey)) {
          throw new DomainValidationError(
            `Invalid idempotency key format: '${input.idempotencyKey}'. Must be a 64-character lowercase hex string.`
          );
        }

        const existingWithKey = await this.paymentRepo.findByIdempotencyKey(
          input.idempotencyKey,
          { tx }
        );
        if (existingWithKey) {
          const persistedRecipient = extractPersistedRecipient(existingWithKey.rawRequest);
          const paramsMatch =
            existingWithKey.milestoneId === input.milestoneId &&
            existingWithKey.submissionId === latestSubmission.id &&
            existingWithKey.amountMinorUnits === milestoneAmountMinorUnits &&
            existingWithKey.currency === milestone.currency &&
            existingWithKey.transactionType === "PAYOUT" &&
            persistedRecipient !== null &&
            persistedRecipient === normalizedRecipient;

          if (!paramsMatch) {
            throw new ConcurrencyConflictError(
              `Idempotency key reuse violation: key '${input.idempotencyKey}' was previously used with different parameters.`
            );
          }
          return {
            transaction: existingWithKey,
            idempotencyKey: existingWithKey.idempotencyKey,
            attemptNumber: existingWithKey.attemptNumber,
            submissionId: latestSubmission.id,
            isExisting: true,
          };
        }
      }

      // 9. Conflicting Active Payment Guard (Cannot bypass active payment by generating another key)
      const activePayment = await this.paymentRepo.findActiveByMilestoneId(
        input.milestoneId,
        { tx }
      );
      if (activePayment) {
        throw new ConcurrencyConflictError(
          `Milestone ${input.milestoneId} already has an active payment transaction (id: ${activePayment.id}, status: '${activePayment.status}'). Conflicting active payout reservations are prohibited.`
        );
      }

      // 10. Atomic attempt-number allocation (under milestone row lock)
      const attemptNumber = await this.paymentRepo.getNextAttemptNumber(
        input.milestoneId,
        "PAYOUT",
        { tx }
      );

      // 11. Idempotency key derivation (RFC 8785 canonical JSON)
      const canonicalPayload: PayoutIdempotencyPayload = {
        amountMinorUnits: milestoneAmountMinorUnits.toString(),
        attemptNumber,
        criteriaHash: latestSubmission.criteriaHash,
        currency: milestone.currency as SupportedCurrency,
        milestoneId: input.milestoneId,
        recipient: normalizedRecipient,
        submissionId: latestSubmission.id,
        transactionType: "PAYOUT" as const,
      };

      const derivedKey = generatePayoutIdempotencyKey(canonicalPayload);
      const idempotencyKey = input.idempotencyKey ?? derivedKey;

      // Double-check if derived key already exists
      const existingWithDerived = await this.paymentRepo.findByIdempotencyKey(
        idempotencyKey,
        { tx }
      );
      if (existingWithDerived) {
        return {
          transaction: existingWithDerived,
          idempotencyKey: existingWithDerived.idempotencyKey,
          attemptNumber: existingWithDerived.attemptNumber,
          submissionId: latestSubmission.id,
          isExisting: true,
        };
      }

      // 12. Create PaymentTransaction in RESERVED status
      const transaction = await this.paymentRepo.createTransaction(
        {
          milestoneId: input.milestoneId,
          submissionId: latestSubmission.id,
          transactionType: "PAYOUT",
          status: "RESERVED",
          idempotencyKey,
          amountMinorUnits: milestoneAmountMinorUnits,
          currency: milestone.currency as SupportedCurrency,
          attemptNumber,
          rawRequest: canonicalPayload as unknown as Record<string, unknown>,
        },
        { tx }
      );

      // 13. Record AuditLog in the same transaction
      const correlationId = input.correlationId ?? transaction.id;
      await this.auditService.recordEvent(
        {
          entityType: "PAYMENT",
          entityId: transaction.id,
          actorType: "SYSTEM",
          actorSystemPrincipal: "WORKER_PAYMENT_COORDINATOR",
          action: "PAYOUT_RESERVED",
          newState: {
            status: "RESERVED",
            attemptNumber,
            idempotencyKey,
            submissionId: latestSubmission.id,
            amountMinorUnits: milestoneAmountMinorUnits.toString(),
            currency: milestone.currency,
          },
          correlationId,
        },
        { tx }
      );

      return {
        transaction,
        idempotencyKey,
        attemptNumber,
        submissionId: latestSubmission.id,
        isExisting: false,
      };
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx, {
      isolationLevel: "ReadCommitted",
    });
  }

  async claimProcessing(
    input: ClaimProcessingInput,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction> {
    const runInTx = async (tx: PrismaTransactionClient): Promise<PaymentTransaction> => {
      // 1. Validate state machine transition: RESERVED -> PROCESSING
      validatePaymentTransition("RESERVED", "PROCESSING");

      // 2. Atomic conditional update
      const updated = await this.paymentRepo.updateStatus(
        input.transactionId,
        input.milestoneId,
        "RESERVED",
        "PROCESSING",
        {},
        { tx }
      );

      // 3. Record AuditLog in the same transaction
      const correlationId = input.correlationId ?? input.transactionId;
      await this.auditService.recordEvent(
        {
          entityType: "PAYMENT",
          entityId: input.transactionId,
          actorType: "SYSTEM",
          actorSystemPrincipal: "WORKER_PAYMENT_COORDINATOR",
          action: input.action ?? "PAYOUT_PROCESSING_STARTED",
          previousState: { status: "RESERVED" },
          newState: { status: "PROCESSING" },
          metadata: input.metadata ?? null,
          correlationId,
        },
        { tx }
      );

      return updated;
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx, {
      isolationLevel: "ReadCommitted",
    });
  }

  async transitionStatus(
    input: TransitionPaymentStatusInput,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction> {
    const runInTx = async (tx: PrismaTransactionClient): Promise<PaymentTransaction> => {
      // 1. Graph transition check
      validatePaymentTransition(input.fromStatus, input.toStatus);

      // 2. Shared Locking Protocol: Acquire Milestone row lock FIRST when transitioning to SUCCEEDED
      if (input.toStatus === "SUCCEEDED") {
        const milestoneRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Milestone"
          WHERE id = ${input.milestoneId}
          FOR UPDATE;
        `;
        if (milestoneRows.length === 0) {
          throw new DomainNotFoundError("Milestone", input.milestoneId);
        }
      }

      // 3. Read and lock target PaymentTransaction row
      const paymentRows = await tx.$queryRaw<Array<{
        id: string;
        milestoneId: string;
        transactionType: string;
        status: string;
      }>>`
        SELECT id, "milestoneId", "transactionType", status
        FROM "PaymentTransaction"
        WHERE id = ${input.transactionId} AND "milestoneId" = ${input.milestoneId}
        FOR UPDATE;
      `;

      const payment = paymentRows[0];
      if (!payment) {
        throw new DomainNotFoundError("PaymentTransaction", input.transactionId);
      }

      if (payment.status !== input.fromStatus) {
        throw new ConcurrencyConflictError(
          `Payment transaction ${input.transactionId} is in status '${payment.status}', expected '${input.fromStatus}'. Status altered or locked by another worker.`
        );
      }

      // 4. Transaction-Type-Specific Successful Payout Guard
      if (input.toStatus === "SUCCEEDED" && payment.transactionType === "PAYOUT") {
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
            `Cannot transition payout ${input.transactionId} to SUCCEEDED: milestone ${input.milestoneId} already has a succeeded payout (${existingSucceeded[0]!.id}).`
          );
        }
      }

      // 5. Update PaymentTransaction
      const updated = await this.paymentRepo.updateStatus(
        input.transactionId,
        input.milestoneId,
        input.fromStatus,
        input.toStatus,
        {
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          paypalOrderId: input.paypalOrderId,
          paypalCaptureId: input.paypalCaptureId,
          paypalPayoutBatchId: input.paypalPayoutBatchId,
          paypalPayoutItemId: input.paypalPayoutItemId,
          rawResponse: input.rawResponse,
        },
        { tx }
      );

      // 6. Record AuditLog in the same transaction
      const correlationId = input.correlationId ?? input.transactionId;
      const defaultActionMap: Partial<Record<PaymentTxStatus, string>> = {
        PROCESSING: "PAYOUT_PROCESSING_STARTED",
        SUCCEEDED: "PAYOUT_SUCCEEDED",
        FAILED: "PAYOUT_FAILED",
        PAYOUT_UNCERTAIN: "PAYOUT_AMBIGUOUS",
        RECONCILIATION_REQUIRED: "PAYOUT_RECONCILIATION_REQUIRED",
      };
      const action =
        input.action ?? defaultActionMap[input.toStatus] ?? `PAYOUT_${input.toStatus}`;
      const actorType = input.actorType ?? "SYSTEM";
      const actorUserId = actorType === "USER" ? input.actorUserId ?? null : null;
      const actorSystemPrincipal =
        actorType === "USER"
          ? null
          : input.actorSystemPrincipal ?? "WORKER_PAYMENT_COORDINATOR";

      await this.auditService.recordEvent(
        {
          entityType: "PAYMENT",
          entityId: input.transactionId,
          actorType,
          actorUserId,
          actorSystemPrincipal,
          action,
          previousState: { status: input.fromStatus },
          newState: {
            status: input.toStatus,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
            paypalPayoutBatchId: input.paypalPayoutBatchId ?? null,
          },
          metadata: input.metadata ?? null,
          correlationId,
        },
        { tx }
      );

      return updated;
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx, {
      isolationLevel: "ReadCommitted",
    });
  }

  async getTransaction(
    id: string,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction | null> {
    return this.paymentRepo.findById(id, options);
  }

  async getTransactionByIdempotencyKey(
    key: string,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction | null> {
    return this.paymentRepo.findByIdempotencyKey(key, options);
  }
}

