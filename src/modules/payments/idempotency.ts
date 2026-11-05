/**
 * VeriRelease Payout Idempotency Key Utilities
 *
 * Deterministic idempotency key derivation using RFC 8785 JSON Canonicalization
 * Scheme (JCS) and SHA-256.
 */

import { z } from "zod";
import {
  type SupportedCurrency,
  supportedCurrencySchema,
} from "../common/money";
import { canonicalizeJson, sha256Hex } from "../common/canonical-json";
import { DomainValidationError } from "../common/errors";

// ==========================================
// Idempotency Payload Definition & Schema
// ==========================================

export interface PayoutIdempotencyPayload {
  amountMinorUnits: bigint | string;
  attemptNumber: number;
  criteriaHash: string;
  currency: SupportedCurrency;
  milestoneId: string;
  recipient: string;
  submissionId: string;
  transactionType: "PAYOUT";
}

/**
 * Normalizes an amount into a canonical positive integer string representation.
 * - Rejects zero and negative amounts for PAYOUT.
 * - Rejects malformed strings (whitespace, decimals, non-digits, signs).
 * - Normalizes leading-zero variants (e.g. "01" -> "1", "007" -> "7") consistently with BigInt (1n -> "1", 7n -> "7").
 */
export function normalizePayoutAmount(amount: bigint | string): string {
  let bi: bigint;

  if (typeof amount === "bigint") {
    bi = amount;
  } else if (typeof amount === "string") {
    // Strictly require non-empty digit string; reject signs (+/-), decimals, exponents, or whitespace
    if (!/^\d+$/.test(amount) || amount.length === 0) {
      throw new DomainValidationError(
        `Invalid monetary amount format: '${amount}'. Must be a non-empty string consisting exclusively of digits.`
      );
    }
    try {
      bi = BigInt(amount);
    } catch {
      throw new DomainValidationError(`Malformed integer amount string: '${amount}'`);
    }
  } else {
    throw new DomainValidationError(
      `Unsupported type for amountMinorUnits: ${typeof amount}. Expected bigint or string.`
    );
  }

  // Reject zero and negative monetary amounts for PAYOUT
  if (bi <= 0n) {
    throw new DomainValidationError(
      `PAYOUT amountMinorUnits must be strictly positive (> 0), got: ${bi}`
    );
  }

  // Canonical positive integer representation without leading zeros
  return bi.toString();
}

export const payoutIdempotencyPayloadSchema = z.object({
  amountMinorUnits: z
    .union([z.string(), z.bigint()])
    .refine(
      (val) => {
        try {
          normalizePayoutAmount(val);
          return true;
        } catch {
          return false;
        }
      },
      {
        message:
          "amountMinorUnits must be a positive integer (> 0) as bigint or non-empty digit string",
      }
    ),
  attemptNumber: z.number().int().positive(),
  criteriaHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "Must be a 64-character lowercase hex digest"),
  currency: supportedCurrencySchema,
  milestoneId: z.string().min(1),
  recipient: z.string().min(1),
  submissionId: z.string().min(1),
  transactionType: z.literal("PAYOUT"),
});

/**
 * Derives a deterministic 64-hex SHA-256 idempotency key from a payout payload
 * using RFC 8785 Canonical JSON Serialization.
 */
export function generatePayoutIdempotencyKey(
  payload: PayoutIdempotencyPayload
): string {
  // Validate input schema
  payoutIdempotencyPayloadSchema.parse(payload);

  // Normalize amount to canonical positive integer string
  const normalizedAmount = normalizePayoutAmount(payload.amountMinorUnits);

  const normalizedObject: Record<string, unknown> = {
    amountMinorUnits: normalizedAmount,
    attemptNumber: payload.attemptNumber,
    criteriaHash: payload.criteriaHash,
    currency: payload.currency,
    milestoneId: payload.milestoneId,
    recipient: payload.recipient,
    submissionId: payload.submissionId,
    transactionType: payload.transactionType,
  };

  const canonicalString = canonicalizeJson(normalizedObject);
  return sha256Hex(canonicalString);
}

/**
 * Validates whether a string matches the required 64-hex lowercase format
 * for an idempotency key.
 */
export function isValidIdempotencyKey(key: string): boolean {
  return /^[0-9a-f]{64}$/.test(key);
}
