/**
 * VeriRelease Payment Recovery Service Implementation
 *
 * Implements recovery of stale RESERVED and stale PROCESSING payment transactions.
 * Stale RESERVED transactions (> threshold) are atomically claimed for processing.
 * Stale PROCESSING transactions (> threshold) are transitioned to PAYOUT_UNCERTAIN.
 *
 * Guaranteed boundaries:
 * - Never auto-redispatches stale PROCESSING transactions.
 * - Never auto-succeeds or auto-fails stale transactions.
 * - Preserves original transaction ID, attempt number, idempotency key, and parameters.
 */

import { prisma, type DbClient } from "../../lib/prisma";
import { ConcurrencyConflictError } from "../common/errors";
import type { PaymentRepository } from "./payment-repository.interface";
import { PrismaPaymentRepository } from "./prisma-payment-repository";
import type { PaymentService } from "./payment-service.interface";
import { extractPersistedRecipient } from "./idempotency";
import type {
  PaymentRecoveryService,
  PaymentRecoveryServiceOptions,
} from "./recovery-service.interface";
import type {
  RecoverStaleReservedInput,
  StaleReservedRecoveryReport,
  StaleReservedRecoveryItem,
  RecoverStaleProcessingInput,
  StaleProcessingRecoveryReport,
  StaleProcessingRecoveryItem,
} from "./payment-service.interface";

export const DEFAULT_STALE_RESERVED_SECONDS = 300; // 5 minutes
export const DEFAULT_STALE_PROCESSING_SECONDS = 120; // 2 minutes

export class PaymentRecoveryServiceImpl implements PaymentRecoveryService {
  constructor(
    private readonly paymentRepo: PaymentRepository = new PrismaPaymentRepository(prisma),
    private readonly paymentService: PaymentService,
    private readonly _client: DbClient = prisma
  ) {}

  async recoverStaleReserved(
    input?: RecoverStaleReservedInput,
    options?: PaymentRecoveryServiceOptions
  ): Promise<StaleReservedRecoveryReport> {
    const olderThanSeconds = input?.olderThanSeconds ?? DEFAULT_STALE_RESERVED_SECONDS;
    const now = input?.now ?? new Date();
    const cutoffDate = new Date(now.getTime() - olderThanSeconds * 1000);
    const limit = input?.limit ?? 50;

    const staleTxs = await this.paymentRepo.findStaleReserved(cutoffDate, limit, options);
    const results: StaleReservedRecoveryItem[] = [];
    let claimedCount = 0;

    for (const tx of staleTxs) {
      const recipient = extractPersistedRecipient(tx.rawRequest);

      try {
        const correlationId = input?.correlationId ?? `recov_res_${tx.id}`;
        await this.paymentService.claimProcessing(
          {
            transactionId: tx.id,
            milestoneId: tx.milestoneId,
            correlationId,
            action: "PAYOUT_RESERVED_RECOVERED",
            metadata: {
              recoveryType: "STALE_RESERVED",
              olderThanSeconds,
              originalCreatedAt: tx.createdAt.toISOString(),
            },
          },
          options
        );

        claimedCount++;
        results.push({
          transactionId: tx.id,
          milestoneId: tx.milestoneId,
          submissionId: tx.submissionId,
          idempotencyKey: tx.idempotencyKey,
          attemptNumber: tx.attemptNumber,
          amountMinorUnits: tx.amountMinorUnits,
          currency: tx.currency,
          recipient,
          claimed: true,
          dispatchReady: true,
        });
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) {
          results.push({
            transactionId: tx.id,
            milestoneId: tx.milestoneId,
            submissionId: tx.submissionId,
            idempotencyKey: tx.idempotencyKey,
            attemptNumber: tx.attemptNumber,
            amountMinorUnits: tx.amountMinorUnits,
            currency: tx.currency,
            recipient,
            claimed: false,
            dispatchReady: false,
            skippedReason:
              "Transaction already claimed by another worker or state altered concurrently",
          });
        } else {
          results.push({
            transactionId: tx.id,
            milestoneId: tx.milestoneId,
            submissionId: tx.submissionId,
            idempotencyKey: tx.idempotencyKey,
            attemptNumber: tx.attemptNumber,
            amountMinorUnits: tx.amountMinorUnits,
            currency: tx.currency,
            recipient,
            claimed: false,
            dispatchReady: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      scannedCount: staleTxs.length,
      claimedCount,
      results,
    };
  }

  async recoverStaleProcessing(
    input?: RecoverStaleProcessingInput,
    options?: PaymentRecoveryServiceOptions
  ): Promise<StaleProcessingRecoveryReport> {
    const olderThanSeconds = input?.olderThanSeconds ?? DEFAULT_STALE_PROCESSING_SECONDS;
    const now = input?.now ?? new Date();
    const cutoffDate = new Date(now.getTime() - olderThanSeconds * 1000);
    const limit = input?.limit ?? 50;
    const reason =
      input?.reason ??
      `Processing timeout: transaction was in PROCESSING for > ${olderThanSeconds}s; external outcome ambiguous`;

    const staleTxs = await this.paymentRepo.findStaleProcessing(cutoffDate, limit, options);
    const results: StaleProcessingRecoveryItem[] = [];
    let transitionedCount = 0;

    for (const tx of staleTxs) {
      try {
        const correlationId = input?.correlationId ?? `recov_proc_${tx.id}`;
        await this.paymentService.transitionStatus(
          {
            transactionId: tx.id,
            milestoneId: tx.milestoneId,
            fromStatus: "PROCESSING",
            toStatus: "PAYOUT_UNCERTAIN",
            action: "PAYOUT_PROCESSING_STALE_UNCERTAIN",
            errorMessage: reason,
            metadata: {
              recoveryType: "STALE_PROCESSING",
              olderThanSeconds,
              reason,
              originalUpdatedAt: tx.updatedAt.toISOString(),
            },
            correlationId,
          },
          options
        );

        transitionedCount++;
        results.push({
          transactionId: tx.id,
          milestoneId: tx.milestoneId,
          submissionId: tx.submissionId,
          idempotencyKey: tx.idempotencyKey,
          attemptNumber: tx.attemptNumber,
          amountMinorUnits: tx.amountMinorUnits,
          currency: tx.currency,
          transitioned: true,
          toStatus: "PAYOUT_UNCERTAIN",
        });
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) {
          results.push({
            transactionId: tx.id,
            milestoneId: tx.milestoneId,
            submissionId: tx.submissionId,
            idempotencyKey: tx.idempotencyKey,
            attemptNumber: tx.attemptNumber,
            amountMinorUnits: tx.amountMinorUnits,
            currency: tx.currency,
            transitioned: false,
            toStatus: "PAYOUT_UNCERTAIN",
            skippedReason:
              "Transaction state was altered or locked concurrently by another worker",
          });
        } else {
          results.push({
            transactionId: tx.id,
            milestoneId: tx.milestoneId,
            submissionId: tx.submissionId,
            idempotencyKey: tx.idempotencyKey,
            attemptNumber: tx.attemptNumber,
            amountMinorUnits: tx.amountMinorUnits,
            currency: tx.currency,
            transitioned: false,
            toStatus: "PAYOUT_UNCERTAIN",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      scannedCount: staleTxs.length,
      transitionedCount,
      results,
    };
  }
}
