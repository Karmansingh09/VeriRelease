/**
 * VeriRelease Payment Reconciliation Repository Interface
 *
 * Defines the persistence boundary for append-only PaymentReconciliation records.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type {
  PaymentReconciliation,
  ReconciliationDecision,
  ReconciliationActorType,
} from "./types";

export interface CreatePaymentReconciliationInput {
  id?: string;
  paymentTransactionId: string;
  decision: ReconciliationDecision;
  reason: string;
  evidenceReference?: string | null;
  evidenceType?: string | null;
  actorType: ReconciliationActorType;
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
  createdAt?: Date;
}

export interface ReconciliationRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface ReconciliationRepository {
  /**
   * Persists an append-only PaymentReconciliation record.
   */
  createReconciliation(
    input: CreatePaymentReconciliationInput,
    options?: ReconciliationRepositoryOptions
  ): Promise<PaymentReconciliation>;

  /**
   * Finds a reconciliation record by its ID.
   */
  findById(
    id: string,
    options?: ReconciliationRepositoryOptions
  ): Promise<PaymentReconciliation | null>;

  /**
   * Finds all reconciliation records associated with a payment transaction.
   */
  findByPaymentTransactionId(
    paymentTransactionId: string,
    options?: ReconciliationRepositoryOptions
  ): Promise<PaymentReconciliation[]>;
}
