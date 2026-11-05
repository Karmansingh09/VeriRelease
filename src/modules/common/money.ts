/**
 * VeriRelease Exact Monetary Representation & ISO 4217 Currency Support
 *
 * Enforces integer BigInt minor units (e.g. cents) with zero floating-point math.
 * Implements the approved 18-currency subset and ISO 4217 exponents.
 */

import { z } from "zod";
import { InvalidMoneyError, UnsupportedCurrencyError } from "./errors";

/**
 * Project-maintained ISO 4217 dataset version.
 * Note: Subject to production verification against official SIX Financial Information AG dataset.
 */
export const CURRENCY_DATASET_VERSION = "ISO-4217-MA-2024-01-01" as const;

/**
 * Curated active subset of 18 high-volume currencies covering zero-, two-, and three-decimal formats:
 * - 13 Two-decimal currencies (1 major unit = 100 minor units)
 * - 2 Zero-decimal currencies (1 major unit = 1 minor unit)
 * - 3 Three-decimal currencies (1 major unit = 1000 minor units)
 */
export const SUPPORTED_CURRENCIES = [
  // Two-decimal currencies (1 major unit = 100 minor units)
  "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "SGD", "HKD", "NZD", "SEK", "NOK", "DKK", "PLN",
  // Zero-decimal currencies (1 major unit = 1 minor unit)
  "JPY", "KRW",
  // Three-decimal currencies (1 major unit = 1000 minor units)
  "BHD", "KWD", "OMR",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const ISO_4217_CURRENCY_EXPONENTS: Record<SupportedCurrency, number> = {
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, CHF: 2,
  SGD: 2, HKD: 2, NZD: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2,
  JPY: 0, KRW: 0,
  BHD: 3, KWD: 3, OMR: 3,
};

/**
 * Zod schema for runtime validation of supported currencies.
 */
export const supportedCurrencySchema = z.enum(SUPPORTED_CURRENCIES, {
  errorMap: (issue) => {
    return { message: `Unsupported currency '${String(issue)}'. Expected one of: ${SUPPORTED_CURRENCIES.join(", ")}` };
  },
});

/**
 * Zod schema for integer minor units (BigInt, strictly non-negative).
 */
export const minorUnitsSchema = z.bigint().nonnegative({
  message: "Monetary amount in minor units must be a non-negative integer",
});

/**
 * Type guard to check if an unknown string is a supported currency.
 */
export function isSupportedCurrency(code: unknown): code is SupportedCurrency {
  return typeof code === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

/**
 * Asserts that a currency code is supported, throwing UnsupportedCurrencyError if not.
 */
export function assertSupportedCurrency(code: unknown): asserts code is SupportedCurrency {
  if (!isSupportedCurrency(code)) {
    throw new UnsupportedCurrencyError(String(code));
  }
}

/**
 * Retrieves the decimal exponent for a supported currency.
 */
export function getCurrencyExponent(currency: SupportedCurrency): number {
  assertSupportedCurrency(currency);
  return ISO_4217_CURRENCY_EXPONENTS[currency];
}

/**
 * Parses a major-unit string (e.g. "100.50", "1000", "5.125") into integer BigInt minor units.
 * STRICT: Zero floating-point operations. Uses string splitting and integer BigInt conversion.
 *
 * @throws {InvalidMoneyError} If the format is invalid or precision exceeds the currency exponent.
 */
export function parseMajorToMinor(majorStr: string, currency: SupportedCurrency): bigint {
  assertSupportedCurrency(currency);
  const trimmed = majorStr.trim();

  // Validate format: optional leading plus, digits, optional decimal point and digits
  if (!/^\+?\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidMoneyError(
      `Invalid monetary string format '${majorStr}'. Must be an unsigned decimal string.`
    );
  }

  const exponent = getCurrencyExponent(currency);
  const cleanStr = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const parts = cleanStr.split(".");
  const wholePart = parts[0] ?? "0";
  const fractionPart = parts[1] ?? "";

  if (exponent === 0) {
    if (fractionPart.length > 0 && fractionPart !== "0") {
      throw new InvalidMoneyError(
        `Currency '${currency}' has exponent 0 and does not accept fractional amounts (received '${majorStr}').`
      );
    }
    return BigInt(wholePart);
  }

  if (fractionPart.length > exponent) {
    throw new InvalidMoneyError(
      `Fractional precision '${fractionPart}' exceeds currency '${currency}' exponent of ${exponent} decimals.`
    );
  }

  // Pad fraction with trailing zeroes to match exponent
  const paddedFraction = fractionPart.padEnd(exponent, "0");
  const combined = `${wholePart}${paddedFraction}`;

  return BigInt(combined);
}

/**
 * Formats BigInt minor units into a major unit string representation.
 * STRICT: Zero floating-point division. Uses string manipulation.
 */
export function formatMinorToMajor(minorUnits: bigint, currency: SupportedCurrency): string {
  assertSupportedCurrency(currency);
  validateNonNegativeAmount(minorUnits, "minorUnits");
  const exponent = getCurrencyExponent(currency);

  if (exponent === 0) {
    return minorUnits.toString();
  }

  const str = minorUnits.toString();
  if (str.length <= exponent) {
    const padded = str.padStart(exponent, "0");
    return `0.${padded}`;
  }

  const whole = str.slice(0, str.length - exponent);
  const fraction = str.slice(str.length - exponent);
  return `${whole}.${fraction}`;
}

/**
 * Validates that an amount in minor units is strictly positive (> 0).
 */
export function validatePositiveAmount(amount: bigint, fieldName = "amountMinorUnits"): void {
  if (amount <= 0n) {
    throw new InvalidMoneyError(`${fieldName} must be strictly positive (> 0), got: ${amount}`);
  }
}

/**
 * Validates that an amount in minor units is non-negative (>= 0).
 */
export function validateNonNegativeAmount(amount: bigint, fieldName = "amountMinorUnits"): void {
  if (amount < 0n) {
    throw new InvalidMoneyError(`${fieldName} cannot be negative, got: ${amount}`);
  }
}

// ==========================================
// Typed Money Model & Currency-Safe Arithmetic
// ==========================================

/**
 * Strongly typed representation of monetary value in VeriRelease.
 * Combines BigInt minor units with an ISO 4217 supported currency code.
 */
export interface Money {
  readonly amountMinorUnits: bigint;
  readonly currency: SupportedCurrency;
}

export const moneySchema = z.object({
  amountMinorUnits: minorUnitsSchema,
  currency: supportedCurrencySchema,
});

export function createMoney(amountMinorUnits: bigint, currency: SupportedCurrency): Money {
  assertSupportedCurrency(currency);
  validateNonNegativeAmount(amountMinorUnits, "amountMinorUnits");
  return { amountMinorUnits, currency };
}

/**
 * Currency-safe addition. Rejects mismatched currencies or negative amounts.
 */
export function addMoney(a: Money, b: Money): Money {
  assertSupportedCurrency(a.currency);
  assertSupportedCurrency(b.currency);

  if (a.currency !== b.currency) {
    throw new InvalidMoneyError(
      `Cannot add money with mismatched currencies: '${a.currency}' and '${b.currency}'`
    );
  }

  validateNonNegativeAmount(a.amountMinorUnits, "Augend");
  validateNonNegativeAmount(b.amountMinorUnits, "Addend");

  return {
    amountMinorUnits: a.amountMinorUnits + b.amountMinorUnits,
    currency: a.currency,
  };
}

/**
 * Currency-safe subtraction. Rejects mismatched currencies, negative minuend/subtrahend,
 * or subtractions that would produce a negative balance.
 */
export function subtractMoney(minuend: Money, subtrahend: Money): Money {
  assertSupportedCurrency(minuend.currency);
  assertSupportedCurrency(subtrahend.currency);

  if (minuend.currency !== subtrahend.currency) {
    throw new InvalidMoneyError(
      `Cannot subtract money with mismatched currencies: '${minuend.currency}' and '${subtrahend.currency}'`
    );
  }

  validateNonNegativeAmount(minuend.amountMinorUnits, "Minuend");
  validateNonNegativeAmount(subtrahend.amountMinorUnits, "Subtrahend");

  if (minuend.amountMinorUnits < subtrahend.amountMinorUnits) {
    throw new InvalidMoneyError(
      `Subtraction would result in negative balance (${minuend.amountMinorUnits} - ${subtrahend.amountMinorUnits} < 0) in ${minuend.currency}`
    );
  }

  return {
    amountMinorUnits: minuend.amountMinorUnits - subtrahend.amountMinorUnits,
    currency: minuend.currency,
  };
}

/**
 * Currency-safe summation of multiple Money objects.
 * Verifies all items share the exact same currency.
 */
export function sumMoney(items: readonly Money[], defaultCurrency?: SupportedCurrency): Money {
  if (items.length === 0) {
    if (!defaultCurrency) {
      throw new InvalidMoneyError("Cannot sum empty money array without specifying a default currency");
    }
    assertSupportedCurrency(defaultCurrency);
    return { amountMinorUnits: 0n, currency: defaultCurrency };
  }

  const targetCurrency = defaultCurrency ?? items[0]!.currency;
  assertSupportedCurrency(targetCurrency);

  let total = 0n;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    assertSupportedCurrency(item.currency);
    if (item.currency !== targetCurrency) {
      throw new InvalidMoneyError(
        `Cannot sum money with mismatched currencies: expected '${targetCurrency}', item at index ${i} has '${item.currency}'`
      );
    }
    validateNonNegativeAmount(item.amountMinorUnits, `Item at index ${i}`);
    total += item.amountMinorUnits;
  }

  return { amountMinorUnits: total, currency: targetCurrency };
}
