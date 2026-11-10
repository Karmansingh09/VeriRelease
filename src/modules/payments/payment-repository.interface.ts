/**
 * VeriRelease Payment Repository Interface
 *
 * Defines the persistence boundary for PaymentTransaction records.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type {
  PaymentTransaction,
  PaymentTxType,
  PaymentTxStatus,
} from "./types";
import type { SupportedCurrency } from "../common/money";

export interface CreatePaymentTransactionInput {
  id?: string;
  milestoneId: string;
  submissionId?: string | null;
  transactionType: PaymentTxType;
  status?: PaymentTxStatus;
  idempotencyKey: string;
  amountMinorUnits: bigint;
  currency: SupportedCurrency;
  attemptNumber: number;
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
  paypalPayoutBatchId?: string | null;
  paypalPayoutItemId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  rawRequest?: Record<string, unknown> | null;
  rawResponse?: Record<string, unknown> | null;
}

export interface UpdatePaymentTransactionData {
  status?: PaymentTxStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
  paypalPayoutBatchId?: string | null;
  paypalPayoutItemId?: string | null;
  rawRequest?: Record<string, unknown> | null;
  rawResponse?: Record<string, unknown> | null;
}

export interface PaymentRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface PaymentRepository {
  /**
   * Creates a new PaymentTransaction record.
   */
  createTransaction(
    input: CreatePaymentTransactionInput,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction>;

  /**
   * Executes an atomic conditional state transition on a PaymentTransaction.
   */
  updateStatus(
    id: string,
    milestoneId: string,
    fromStatus: PaymentTxStatus,
    toStatus: PaymentTxStatus,
    data?: UpdatePaymentTransactionData,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction>;

  /**
   * Finds a payment transaction by its primary key ID.
   */
  findById(
    id: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null>;

  /**
   * Finds a payment transaction by its unique idempotency key.
   */
  findByIdempotencyKey(
    key: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null>;

  /**
   * Finds any active payment transaction for a milestone
   * (status in RESERVED, PROCESSING, PAYOUT_UNCERTAIN, RECONCILIATION_REQUIRED).
   */
  findActiveByMilestoneId(
    milestoneId: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null>;

  /**
   * Finds an existing SUCCEEDED PAYOUT transaction for a milestone.
   */
  findSucceededPayoutByMilestoneId(
    milestoneId: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null>;

  /**
   * Finds all payment transactions for a milestone ordered chronologically.
   */
  findByMilestoneId(
    milestoneId: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction[]>;

  /**
   * Allocates the next sequential attempt number for a milestone and transaction type.
   */
  getNextAttemptNumber(
    milestoneId: string,
    transactionType: PaymentTxType,
    options?: PaymentRepositoryOptions
  ): Promise<number>;
}
