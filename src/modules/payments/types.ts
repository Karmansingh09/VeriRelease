/**
 * VeriRelease Payment Domain Types
 *
 * Strongly typed entities, enums, and Zod schemas for Payment Transactions
 * and Idempotency payloads.
 */

import { z } from "zod";
import {
  type SupportedCurrency,
  supportedCurrencySchema,
  minorUnitsSchema,
} from "../common/money";

// ==========================================
// Payment Transaction Enums & Constants
// ==========================================

export const PAYMENT_TX_TYPES = [
  "FUNDING_AUTHORIZATION",
  "PAYOUT",
  "REFUND",
] as const;
export type PaymentTxType = (typeof PAYMENT_TX_TYPES)[number];
export const paymentTxTypeSchema = z.enum(PAYMENT_TX_TYPES);

export const PAYMENT_TX_STATUSES = [
  "CREATED",
  "RESERVED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "PAYOUT_UNCERTAIN",
  "RECONCILIATION_REQUIRED",
] as const;
export type PaymentTxStatus = (typeof PAYMENT_TX_STATUSES)[number];
export const paymentTxStatusSchema = z.enum(PAYMENT_TX_STATUSES);

// ==========================================
// PaymentTransaction Domain Entity
// ==========================================

export interface PaymentTransaction {
  id: string;
  milestoneId: string;
  submissionId: string | null;
  transactionType: PaymentTxType;
  status: PaymentTxStatus;
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
  createdAt: Date;
  updatedAt: Date;
}

export const paymentTransactionSchema = z
  .object({
    id: z.string().min(1),
    milestoneId: z.string().min(1),
    submissionId: z.string().min(1).nullable().optional(),
    transactionType: paymentTxTypeSchema,
    status: paymentTxStatusSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[0-9a-f]{64}$/, "Must be a 64-character lowercase hex digest"),
    amountMinorUnits: minorUnitsSchema.refine((val) => val > 0n, {
      message: "Payment amountMinorUnits must be strictly positive (> 0)",
    }),
    currency: supportedCurrencySchema,
    attemptNumber: z.number().int().positive(),
    paypalOrderId: z.string().nullable().optional(),
    paypalCaptureId: z.string().nullable().optional(),
    paypalPayoutBatchId: z.string().nullable().optional(),
    paypalPayoutItemId: z.string().nullable().optional(),
    errorCode: z.string().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
    rawRequest: z.record(z.unknown()).nullable().optional(),
    rawResponse: z.record(z.unknown()).nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine(
    (tx) => {
      // Invariant: chk_payment_payout_requires_submission
      // PAYOUT requires non-null submissionId; non-PAYOUT requires null submissionId
      if (tx.transactionType === "PAYOUT") {
        return typeof tx.submissionId === "string" && tx.submissionId.length > 0;
      }
      return tx.submissionId === null || tx.submissionId === undefined;
    },
    {
      message:
        "PAYOUT transactions require a non-null submissionId; FUNDING_AUTHORIZATION and REFUND must have a null submissionId",
      path: ["submissionId"],
    }
  );

// ==========================================
// Payment Reconciliation Types
// ==========================================

export const RECONCILIATION_DECISIONS = [
  "CONFIRMED_SUCCEEDED",
  "CONFIRMED_FAILED",
  "STILL_UNCERTAIN",
] as const;
export type ReconciliationDecision = (typeof RECONCILIATION_DECISIONS)[number];
export const reconciliationDecisionSchema = z.enum(RECONCILIATION_DECISIONS);

export const RECONCILIATION_ACTOR_TYPES = [
  "USER",
  "SYSTEM_PRINCIPAL",
  "WEBHOOK_GITHUB",
  "WEBHOOK_PAYPAL",
  "SYSTEM",
] as const;
export type ReconciliationActorType = (typeof RECONCILIATION_ACTOR_TYPES)[number];
export const reconciliationActorTypeSchema = z.enum(RECONCILIATION_ACTOR_TYPES);

export interface PaymentReconciliation {
  id: string;
  paymentTransactionId: string;
  decision: ReconciliationDecision;
  reason: string;
  evidenceReference?: string | null;
  evidenceType?: string | null;
  actorType: ReconciliationActorType;
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
  createdAt: Date;
}

export const paymentReconciliationSchema = z
  .object({
    id: z.string().min(1),
    paymentTransactionId: z.string().min(1),
    decision: reconciliationDecisionSchema,
    reason: z.string().trim().min(1, "Reconciliation reason must not be empty"),
    evidenceReference: z.string().trim().min(1).nullable().optional(),
    evidenceType: z.string().trim().min(1).nullable().optional(),
    actorType: reconciliationActorTypeSchema,
    actorUserId: z.string().trim().min(1).nullable().optional(),
    actorSystemPrincipal: z.string().trim().min(1).nullable().optional(),
    createdAt: z.date(),
  })
  .refine(
    (rec) => {
      // CONFIRMED_SUCCEEDED and CONFIRMED_FAILED require a non-empty evidenceReference
      if (rec.decision === "CONFIRMED_SUCCEEDED" || rec.decision === "CONFIRMED_FAILED") {
        return typeof rec.evidenceReference === "string" && rec.evidenceReference.trim().length > 0;
      }
      return true;
    },
    {
      message: "CONFIRMED_SUCCEEDED and CONFIRMED_FAILED require a non-empty evidenceReference",
      path: ["evidenceReference"],
    }
  )
  .refine(
    (rec) => {
      if (rec.actorType === "USER") {
        return Boolean(rec.actorUserId && !rec.actorSystemPrincipal);
      }
      return Boolean(!rec.actorUserId && rec.actorSystemPrincipal);
    },
    {
      message:
        "USER actor requires actorUserId and no actorSystemPrincipal; non-USER actor requires actorSystemPrincipal and no actorUserId",
      path: ["actorType"],
    }
  );
