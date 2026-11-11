/**
 * VeriRelease PayPal Payout Coordinator
 *
 * Orchestrates authorized payout execution for ELIGIBLE_FOR_PAYOUT milestones:
 * 1. Verifies caller is the authenticated Contract Client.
 * 2. Verifies milestone status is ELIGIBLE_FOR_PAYOUT.
 * 3. Uses authoritative database amount and currency (never trusts frontend amounts).
 * 4. Reserves payout via PaymentCoordinatorService (enforcing idempotency & row locks).
 * 5. Claims PROCESSING state.
 * 6. Creates and captures PayPal Sandbox order via PayPalClient.
 * 7. Verifies capture response status and captured amount strictly match database intent.
 * 8. Transitions transaction to SUCCEEDED, FAILED, or PAYOUT_UNCERTAIN (never blind-retrying).
 * 9. Emits transactional audit events.
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient } from "../../lib/prisma";
import { formatMinorToMajor, type SupportedCurrency } from "../common/money";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
} from "../common/errors";
import type { DefaultAuditService } from "../audit";
import type { PaymentService } from "./payment-service.interface";
import type { PayPalClient } from "./paypal/paypal-client.interface";
import { PayPalAmbiguousResponseError } from "./paypal/rest-paypal-client";
import type { PaymentTransaction } from "./types";

export interface TriggerPayoutInput {
  milestoneId: string;
  callerId: string;
  developerPayPalEmail?: string;
}

export interface TriggerPayoutResult {
  transaction: PaymentTransaction;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  providerStatus: string;
  isDemoMode: boolean;
  message: string;
}

export class PayoutCoordinator {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly paypalClient: PayPalClient,
    private readonly auditService: DefaultAuditService,
    private readonly client: DbClient = prisma
  ) {}

  async executePayout(input: TriggerPayoutInput): Promise<TriggerPayoutResult> {
    const correlationId = `corr_pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    // 1. Fetch milestone, contract, and developer
    const milestone = await this.client.milestone.findUnique({
      where: { id: input.milestoneId },
      include: {
        contract: {
          include: {
            developer: {
              select: {
                id: true,
                email: true,
                paypalReceiverEmail: true,
              },
            },
          },
        },
      },
    });

    if (!milestone) {
      throw new DomainNotFoundError("Milestone", input.milestoneId);
    }

    // 2. Enforce contract client authorization
    if (milestone.contract.clientId !== input.callerId) {
      throw new DomainForbiddenError(
        "Only the contract client is authorized to trigger milestone payouts"
      );
    }

    const developerPayPalEmail =
      input.developerPayPalEmail?.trim() ||
      milestone.contract.developer.paypalReceiverEmail ||
      milestone.contract.developer.email;

    if (!developerPayPalEmail) {
      throw new DomainValidationError(
        "Developer PayPal receiver email is required for payout"
      );
    }

    const currency = milestone.currency as SupportedCurrency;
    const amountMinorUnits = BigInt(milestone.amountMinorUnits);
    const formattedMajorAmount = formatMinorToMajor(amountMinorUnits, currency);

    // 3. Reserve payout via PaymentCoordinatorService (acquires FOR UPDATE lock, validates ELIGIBLE_FOR_PAYOUT, checks duplicates)
    const reservation = await this.paymentService.reservePayout({
      milestoneId: milestone.id,
      developerPayPalEmail,
      amountMinorUnits,
      currency,
      correlationId,
    });

    // If an existing transaction was returned in terminal SUCCEEDED state, return it cleanly
    if (reservation.isExisting && reservation.transaction.status === "SUCCEEDED") {
      return {
        transaction: reservation.transaction,
        paypalOrderId: reservation.transaction.paypalOrderId ?? null,
        paypalCaptureId: reservation.transaction.paypalCaptureId ?? null,
        providerStatus: "COMPLETED",
        isDemoMode: this.paypalClient.mode === "mock",
        message: "Payment already completed previously (idempotent replay protected).",
      };
    }

    // If existing transaction is uncertain, do not blindly retry
    if (
      reservation.isExisting &&
      (reservation.transaction.status === "PAYOUT_UNCERTAIN" ||
        reservation.transaction.status === "RECONCILIATION_REQUIRED")
    ) {
      return {
        transaction: reservation.transaction,
        paypalOrderId: reservation.transaction.paypalOrderId ?? null,
        paypalCaptureId: reservation.transaction.paypalCaptureId ?? null,
        providerStatus: "UNCERTAIN",
        isDemoMode: this.paypalClient.mode === "mock",
        message: "Previous payout attempt resulted in an uncertain state and requires reconciliation.",
      };
    }

    const txId = reservation.transaction.id;

    // 4. Claim PROCESSING status if currently RESERVED
    let currentTx = reservation.transaction;
    if (currentTx.status === "RESERVED") {
      currentTx = await this.paymentService.claimProcessing({
        transactionId: txId,
        milestoneId: milestone.id,
        correlationId,
      });
    }

    let orderId: string | null = currentTx.paypalOrderId ?? null;

    try {
      // 5. Create PayPal Sandbox Order
      if (!orderId) {
        const orderResult = await this.paypalClient.createOrder({
          referenceId: milestone.id,
          amountMajor: formattedMajorAmount,
          currency,
          description: `VeriRelease Payout: ${milestone.contract.title} — ${milestone.title}`,
          payeeEmail: developerPayPalEmail,
          customId: txId,
        });
        orderId = orderResult.orderId;
      }

      // 6. Capture PayPal Sandbox Order with provider-level idempotency key
      const captureResult = await this.paypalClient.captureOrder({
        orderId,
        idempotencyKey: reservation.idempotencyKey,
      });

      // 7. Verify captured status, amount, and currency before recording SUCCEEDED
      if (captureResult.status !== "COMPLETED") {
        const failedTx = await this.paymentService.transitionStatus({
          transactionId: txId,
          milestoneId: milestone.id,
          fromStatus: "PROCESSING",
          toStatus: "FAILED",
          paypalOrderId: orderId,
          paypalCaptureId: captureResult.captureId,
          errorCode: `PAYPAL_CAPTURE_${captureResult.status}`,
          errorMessage: `PayPal capture returned status '${captureResult.status}' instead of 'COMPLETED'`,
          rawResponse: captureResult.rawResponse,
          correlationId,
        });

        return {
          transaction: failedTx,
          paypalOrderId: orderId,
          paypalCaptureId: captureResult.captureId,
          providerStatus: captureResult.status,
          isDemoMode: this.paypalClient.mode === "mock",
          message: `PayPal capture did not complete (status: ${captureResult.status}).`,
        };
      }

      if (
        captureResult.capturedAmountMajor !== formattedMajorAmount ||
        captureResult.currency !== currency
      ) {
        const failedTx = await this.paymentService.transitionStatus({
          transactionId: txId,
          milestoneId: milestone.id,
          fromStatus: "PROCESSING",
          toStatus: "FAILED",
          paypalOrderId: orderId,
          paypalCaptureId: captureResult.captureId,
          errorCode: "PAYPAL_AMOUNT_MISMATCH",
          errorMessage: `Captured amount (${captureResult.capturedAmountMajor} ${captureResult.currency}) does not match milestone intent (${formattedMajorAmount} ${currency})`,
          rawResponse: captureResult.rawResponse,
          correlationId,
        });

        return {
          transaction: failedTx,
          paypalOrderId: orderId,
          paypalCaptureId: captureResult.captureId,
          providerStatus: "AMOUNT_MISMATCH",
          isDemoMode: this.paypalClient.mode === "mock",
          message: "Captured amount did not match authorized milestone amount.",
        };
      }

      // 8. Verified SUCCEEDED: update local transaction state
      const succeededTx = await this.paymentService.transitionStatus({
        transactionId: txId,
        milestoneId: milestone.id,
        fromStatus: "PROCESSING",
        toStatus: "SUCCEEDED",
        paypalOrderId: orderId,
        paypalCaptureId: captureResult.captureId,
        rawResponse: captureResult.rawResponse,
        correlationId,
        action: "PAYMENT_SUCCEEDED",
        actorType: "USER",
        actorUserId: input.callerId,
      });

      return {
        transaction: succeededTx,
        paypalOrderId: orderId,
        paypalCaptureId: captureResult.captureId,
        providerStatus: "COMPLETED",
        isDemoMode: this.paypalClient.mode === "mock",
        message: "PayPal Sandbox payout successfully captured and settled.",
      };
    } catch (err: unknown) {
      // 9. Handle ambiguous / timeout / 5xx error safely -> PAYOUT_UNCERTAIN
      if (err instanceof PayPalAmbiguousResponseError) {
        const uncertainTx = await this.paymentService.transitionStatus({
          transactionId: txId,
          milestoneId: milestone.id,
          fromStatus: "PROCESSING",
          toStatus: "PAYOUT_UNCERTAIN",
          paypalOrderId: orderId,
          errorCode: "PAYPAL_AMBIGUOUS_RESPONSE",
          errorMessage: err.message,
          correlationId,
          action: "PAYMENT_MARKED_UNCERTAIN",
        });

        return {
          transaction: uncertainTx,
          paypalOrderId: orderId,
          paypalCaptureId: null,
          providerStatus: "UNCERTAIN",
          isDemoMode: this.paypalClient.mode === "mock",
          message: "Payment outcome is uncertain due to provider timeout or 5xx error. Manual or automated reconciliation is required.",
        };
      }

      // 10. Definitive rejection -> FAILED
      const failedTx = await this.paymentService.transitionStatus({
        transactionId: txId,
        milestoneId: milestone.id,
        fromStatus: "PROCESSING",
        toStatus: "FAILED",
        paypalOrderId: orderId,
        errorCode: "PAYPAL_PROVIDER_ERROR",
        errorMessage: err instanceof Error ? err.message : "Unknown PayPal error",
        correlationId,
        action: "PAYMENT_FAILED",
      });

      return {
        transaction: failedTx,
        paypalOrderId: orderId,
        paypalCaptureId: null,
        providerStatus: "FAILED",
        isDemoMode: this.paypalClient.mode === "mock",
        message: err instanceof Error ? err.message : "Payment execution failed",
      };
    }
  }

  /**
   * Retrieves all payment transactions for a milestone.
   */
  async getMilestonePayments(milestoneId: string, callerId: string) {
    const milestone = await this.client.milestone.findUnique({
      where: { id: milestoneId },
      include: { contract: true },
    });

    if (!milestone) {
      throw new DomainNotFoundError("Milestone", milestoneId);
    }

    if (milestone.contract.clientId !== callerId && milestone.contract.developerId !== callerId) {
      const user = await this.client.user.findUnique({ where: { id: callerId } });
      if (user?.role !== "ADMIN") {
        throw new DomainForbiddenError("You are not authorized to view milestone payments");
      }
    }

    const txs = await this.client.paymentTransaction.findMany({
      where: { milestoneId },
      orderBy: { createdAt: "desc" },
    });

    return txs.map((tx) => ({
      ...tx,
      amountMinorUnits: tx.amountMinorUnits.toString(),
    }));
  }
}
