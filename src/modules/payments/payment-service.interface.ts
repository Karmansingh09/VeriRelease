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
