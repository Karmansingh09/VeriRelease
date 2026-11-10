/**
 * VeriRelease Payment Service Interface
 *
 * Defines the application boundary for payment reservation, idempotency coordination,
 * processing claims, and payment state transitions.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type {
  PaymentTransaction,
  PaymentTxStatus,
} from "./types";
import type { AuditActorType } from "../audit/types";
import type {
  ReconcilePaymentInput,
  ReconcilePaymentResult,
} from "./reconciliation-service.interface";

export type { ReconcilePaymentInput, ReconcilePaymentResult };

export interface ReservePayoutInput {
  milestoneId: string;
  submissionId?: string;
  expectedCriteriaHash?: string;
  developerPayPalEmail: string;
  amountMinorUnits?: bigint | string;
  currency?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

export interface ReservePayoutResult {
  transaction: PaymentTransaction;
  idempotencyKey: string;
  attemptNumber: number;
  submissionId: string;
  isExisting: boolean;
}

export interface ClaimProcessingInput {
  transactionId: string;
  milestoneId: string;
  correlationId?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionPaymentStatusInput {
  transactionId: string;
  milestoneId: string;
  fromStatus: PaymentTxStatus;
  toStatus: PaymentTxStatus;
  action?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
  paypalPayoutBatchId?: string | null;
  paypalPayoutItemId?: string | null;
  rawResponse?: Record<string, unknown> | null;
  correlationId?: string;
  metadata?: Record<string, unknown> | null;
  actorType?: AuditActorType | "SYSTEM";
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
}

export interface RecoverStaleReservedInput {
  olderThanSeconds?: number;
  limit?: number;
  now?: Date;
  correlationId?: string;
}

export interface StaleReservedRecoveryItem {
  transactionId: string;
  milestoneId: string;
  submissionId: string | null;
  idempotencyKey: string;
  attemptNumber: number;
  amountMinorUnits: bigint;
  currency: string;
  recipient: string | null;
  claimed: boolean;
  dispatchReady: boolean;
  skippedReason?: string;
  error?: string;
}

export interface StaleReservedRecoveryReport {
  scannedCount: number;
  claimedCount: number;
  results: StaleReservedRecoveryItem[];
}

export interface RecoverStaleProcessingInput {
  olderThanSeconds?: number;
  limit?: number;
  now?: Date;
  reason?: string;
  correlationId?: string;
}

export interface StaleProcessingRecoveryItem {
  transactionId: string;
  milestoneId: string;
  submissionId: string | null;
  idempotencyKey: string;
  attemptNumber: number;
  amountMinorUnits: bigint;
  currency: string;
  transitioned: boolean;
  toStatus: "PAYOUT_UNCERTAIN";
  skippedReason?: string;
  error?: string;
}

export interface StaleProcessingRecoveryReport {
  scannedCount: number;
  transitionedCount: number;
  results: StaleProcessingRecoveryItem[];
}

export interface PaymentServiceOptions {
  tx?: PrismaTransactionClient;
}

export interface PaymentService {
  /**
   * Reserves a payout for an eligible milestone under PostgreSQL row-level locking.
   * Enforces persisted policy approval, criteria hash equality, idempotency,
   * single active payment, and single succeeded payout guards.
   */
  reservePayout(
    input: ReservePayoutInput,
    options?: PaymentServiceOptions
  ): Promise<ReservePayoutResult>;

  /**
   * Atomically claims a RESERVED payment transaction for PROCESSING.
   */
  claimProcessing(
    input: ClaimProcessingInput,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction>;

  /**
   * Executes an atomic payment state transition using parameterized queries and shared locking protocol.
   */
  transitionStatus(
    input: TransitionPaymentStatusInput,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction>;

  /**
   * Evaluates an unresolved payment transaction against authoritative evidence
   * and commits an explicit reconciliation decision (CONFIRMED_SUCCEEDED, CONFIRMED_FAILED, STILL_UNCERTAIN).
   */
  reconcilePayment(
    input: ReconcilePaymentInput,
    options?: PaymentServiceOptions
  ): Promise<ReconcilePaymentResult>;

  /**
   * Identifies stale RESERVED transactions (> olderThanSeconds) and atomically claims them
   * for processing, returning a dispatch-ready report with preserved original parameters.
   */
  recoverStaleReserved(
    input?: RecoverStaleReservedInput,
    options?: PaymentServiceOptions
  ): Promise<StaleReservedRecoveryReport>;

  /**
   * Identifies stale PROCESSING transactions (> olderThanSeconds) and transitions them
   * to PAYOUT_UNCERTAIN, preserving the active payment guard.
   */
  recoverStaleProcessing(
    input?: RecoverStaleProcessingInput,
    options?: PaymentServiceOptions
  ): Promise<StaleProcessingRecoveryReport>;

  /**
   * Retrieves a payment transaction by primary ID.
   */
  getTransaction(
    id: string,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction | null>;

  /**
   * Retrieves a payment transaction by its idempotency key.
   */
  getTransactionByIdempotencyKey(
    key: string,
    options?: PaymentServiceOptions
  ): Promise<PaymentTransaction | null>;
}
