/**
 * VeriRelease Payment Reconciliation Service Interface
 *
 * Defines the application boundary for evaluating unresolved payment transactions
 * against authoritative external evidence and recording immutable reconciliation decisions.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type {
  PaymentReconciliation,
  PaymentTransaction,
  ReconciliationDecision,
  ReconciliationActorType,
} from "./types";

export interface ReconcilePaymentInput {
  transactionId: string;
  milestoneId: string;
  decision: ReconciliationDecision;
  reason: string;
  evidenceReference?: string | null;
  evidenceType?: string | null;
  actor: {
    actorType: ReconciliationActorType;
    actorUserId?: string | null;
    actorSystemPrincipal?: string | null;
  };
  correlationId?: string;
}

export interface ReconcilePaymentResult {
  transaction: PaymentTransaction;
  reconciliation: PaymentReconciliation;
}

export interface PaymentReconciliationServiceOptions {
  tx?: PrismaTransactionClient;
}

export interface PaymentReconciliationService {
  /**
   * Reconciles an unresolved payment transaction against authoritative evidence.
   * Enforces milestone-first locking on CONFIRMED_SUCCEEDED, duplicate payout guards,
   * non-empty reason and evidence, and atomic audit logging.
   */
  reconcilePayment(
    input: ReconcilePaymentInput,
    options?: PaymentReconciliationServiceOptions
  ): Promise<ReconcilePaymentResult>;

  /**
   * Retrieves a reconciliation record by ID.
   */
  getReconciliation(
    id: string,
    options?: PaymentReconciliationServiceOptions
  ): Promise<PaymentReconciliation | null>;

  /**
   * Retrieves all reconciliation records for a given payment transaction.
   */
  getReconciliationsForTransaction(
    paymentTransactionId: string,
    options?: PaymentReconciliationServiceOptions
  ): Promise<PaymentReconciliation[]>;
}
