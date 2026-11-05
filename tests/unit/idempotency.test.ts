import { describe, it, expect } from "vitest";
import {
  generatePayoutIdempotencyKey,
  isValidIdempotencyKey,
  normalizePayoutAmount,
  type PayoutIdempotencyPayload,
} from "../../src/modules/payments/idempotency";
import { DomainValidationError } from "../../src/modules/common/errors";

describe("Payout Idempotency Utilities", () => {
  const basePayload: PayoutIdempotencyPayload = {
    amountMinorUnits: 10000n,
    attemptNumber: 1,
    criteriaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    currency: "USD",
    milestoneId: "m_test_123",
    recipient: "dev@example.com",
    submissionId: "sub_test_456",
    transactionType: "PAYOUT",
  };

  describe("Amount Normalization (normalizePayoutAmount)", () => {
    it("normalizes BigInt amounts to integer string without exponential notation", () => {
      expect(normalizePayoutAmount(1n)).toBe("1");
      expect(normalizePayoutAmount(10050n)).toBe("10050");
      expect(normalizePayoutAmount(9007199254740991n)).toBe("9007199254740991");
    });

    it("normalizes clean digit strings to canonical integer string", () => {
      expect(normalizePayoutAmount("1")).toBe("1");
      expect(normalizePayoutAmount("5000")).toBe("5000");
    });

    it("normalizes leading-zero string variants consistently with BigInt values", () => {
      expect(normalizePayoutAmount("01")).toBe("1");
      expect(normalizePayoutAmount("007")).toBe("7");
      expect(normalizePayoutAmount("000100")).toBe("100");

      // Verifies equality between normalized string and BigInt
      expect(normalizePayoutAmount("01")).toBe(normalizePayoutAmount(1n));
      expect(normalizePayoutAmount("007")).toBe(normalizePayoutAmount(7n));
      expect(normalizePayoutAmount("000100")).toBe(normalizePayoutAmount(100n));
    });

    it("rejects zero amounts (0n, '0', '00')", () => {
      expect(() => normalizePayoutAmount(0n)).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("0")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("00")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("000")).toThrow(DomainValidationError);
    });

    it("rejects negative monetary amounts", () => {
      expect(() => normalizePayoutAmount(-1n)).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("-1")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("-500")).toThrow(DomainValidationError);
    });

    it("rejects malformed integer strings (whitespace, decimals, exponents, signs, hex)", () => {
      expect(() => normalizePayoutAmount("")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount(" ")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount(" 100 ")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("+100")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("100.5")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("1e5")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("0x10")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("abc")).toThrow(DomainValidationError);
      expect(() => normalizePayoutAmount("100a")).toThrow(DomainValidationError);
    });
  });

  describe("generatePayoutIdempotencyKey", () => {
    it("generates deterministic 64-character lowercase hex key", () => {
      const key = generatePayoutIdempotencyKey(basePayload);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(isValidIdempotencyKey(key)).toBe(true);
    });

    it("ensures '1' and 1n produce identical payload representations and idempotency keys", () => {
      const keyFromString = generatePayoutIdempotencyKey({
        ...basePayload,
        amountMinorUnits: "1",
      });
      const keyFromBigInt = generatePayoutIdempotencyKey({
        ...basePayload,
        amountMinorUnits: 1n,
      });

      expect(keyFromString).toBe(keyFromBigInt);
    });

    it("ensures leading-zero variants produce identical idempotency keys to canonical integer representation", () => {
      const keyCanonical = generatePayoutIdempotencyKey({
        ...basePayload,
        amountMinorUnits: "100",
      });
      const keyLeadingZero = generatePayoutIdempotencyKey({
        ...basePayload,
        amountMinorUnits: "00100",
      });
      const keyBigInt = generatePayoutIdempotencyKey({
        ...basePayload,
        amountMinorUnits: 100n,
      });

      expect(keyLeadingZero).toBe(keyCanonical);
      expect(keyLeadingZero).toBe(keyBigInt);
    });

    it("produces identical key regardless of object property ordering", () => {
      const payloadA: PayoutIdempotencyPayload = {
        amountMinorUnits: 10000n,
        attemptNumber: 1,
        criteriaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        currency: "USD",
        milestoneId: "m_test_123",
        recipient: "dev@example.com",
        submissionId: "sub_test_456",
        transactionType: "PAYOUT",
      };

      const payloadB: PayoutIdempotencyPayload = {
        transactionType: "PAYOUT",
        recipient: "dev@example.com",
        submissionId: "sub_test_456",
        milestoneId: "m_test_123",
        currency: "USD",
        criteriaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        attemptNumber: 1,
        amountMinorUnits: "10000",
      };

      expect(generatePayoutIdempotencyKey(payloadA)).toBe(
        generatePayoutIdempotencyKey(payloadB)
      );
    });

    it("alters idempotency key when any parameter changes", () => {
      const originalKey = generatePayoutIdempotencyKey(basePayload);

      // Change amount
      expect(
        generatePayoutIdempotencyKey({ ...basePayload, amountMinorUnits: 10001n })
      ).not.toBe(originalKey);

      // Change attempt number
      expect(
        generatePayoutIdempotencyKey({ ...basePayload, attemptNumber: 2 })
      ).not.toBe(originalKey);

      // Change criteria hash
      expect(
        generatePayoutIdempotencyKey({
          ...basePayload,
          criteriaHash: "0000000000000000000000000000000000000000000000000000000000000000",
        })
      ).not.toBe(originalKey);

      // Change currency
      expect(
        generatePayoutIdempotencyKey({ ...basePayload, currency: "EUR" })
      ).not.toBe(originalKey);

      // Change milestone ID
      expect(
        generatePayoutIdempotencyKey({ ...basePayload, milestoneId: "m_test_999" })
      ).not.toBe(originalKey);

      // Change recipient
      expect(
        generatePayoutIdempotencyKey({ ...basePayload, recipient: "other@example.com" })
      ).not.toBe(originalKey);

      // Change submission ID
      expect(
        generatePayoutIdempotencyKey({ ...basePayload, submissionId: "sub_test_999" })
      ).not.toBe(originalKey);
    });

    it("rejects zero, negative, and malformed amounts in payout payload", () => {
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, amountMinorUnits: 0n })
      ).toThrow();
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, amountMinorUnits: "0" })
      ).toThrow();
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, amountMinorUnits: -100n })
      ).toThrow();
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, amountMinorUnits: "-100" })
      ).toThrow();
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, amountMinorUnits: "100.50" })
      ).toThrow();
    });
  });

  describe("isValidIdempotencyKey", () => {
    it("accepts valid 64-char lowercase hex strings", () => {
      expect(
        isValidIdempotencyKey(
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
      ).toBe(true);
    });

    it("rejects invalid keys", () => {
      expect(
        isValidIdempotencyKey(
          "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"
        )
      ).toBe(false);
      expect(isValidIdempotencyKey("e3b0c44298fc1c149afbf4c8996fb92427ae41e")).toBe(false);
      expect(isValidIdempotencyKey("g".repeat(64))).toBe(false);
      expect(isValidIdempotencyKey("")).toBe(false);
    });
  });

  describe("Validation errors on invalid payload schema", () => {
    it("rejects non-positive attempt number", () => {
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, attemptNumber: 0 })
      ).toThrow();
    });

    it("rejects invalid criteria hash format", () => {
      expect(() =>
        generatePayoutIdempotencyKey({ ...basePayload, criteriaHash: "not-a-hash" })
      ).toThrow();
    });

    it("rejects unsupported currency", () => {
      expect(() =>
        generatePayoutIdempotencyKey({
          ...basePayload,
          // @ts-expect-error testing invalid currency
          currency: "XYZ",
        })
      ).toThrow();
    });
  });
});
