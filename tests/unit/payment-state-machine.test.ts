import { describe, it, expect } from "vitest";
import {
  ALLOWED_PAYMENT_TRANSITIONS,
  isPaymentTransitionAllowed,
  validatePaymentTransition,
  assertDecoupledStateMachines,
} from "../../src/modules/payments/payment-state-machine";
import {
  PAYMENT_TX_STATUSES,
  type PaymentTxStatus,
} from "../../src/modules/payments/types";
import { InvalidStateTransitionError } from "../../src/modules/common/errors";

describe("Payment State Machine", () => {
  it("defines exactly 7 payment transaction states", () => {
    expect(PAYMENT_TX_STATUSES).toEqual([
      "CREATED",
      "RESERVED",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED",
      "PAYOUT_UNCERTAIN",
      "RECONCILIATION_REQUIRED",
    ]);
  });

  describe("isPaymentTransitionAllowed & validatePaymentTransition", () => {
    it("allows CREATED -> RESERVED", () => {
      expect(isPaymentTransitionAllowed("CREATED", "RESERVED")).toBe(true);
      expect(() => validatePaymentTransition("CREATED", "RESERVED")).not.toThrow();
    });

    it("allows RESERVED -> PROCESSING", () => {
      expect(isPaymentTransitionAllowed("RESERVED", "PROCESSING")).toBe(true);
      expect(() => validatePaymentTransition("RESERVED", "PROCESSING")).not.toThrow();
    });

    it("allows PROCESSING -> SUCCEEDED, FAILED, PAYOUT_UNCERTAIN", () => {
      expect(isPaymentTransitionAllowed("PROCESSING", "SUCCEEDED")).toBe(true);
      expect(isPaymentTransitionAllowed("PROCESSING", "FAILED")).toBe(true);
      expect(isPaymentTransitionAllowed("PROCESSING", "PAYOUT_UNCERTAIN")).toBe(true);
    });

    it("allows PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED, SUCCEEDED, FAILED", () => {
      expect(isPaymentTransitionAllowed("PAYOUT_UNCERTAIN", "RECONCILIATION_REQUIRED")).toBe(true);
      expect(isPaymentTransitionAllowed("PAYOUT_UNCERTAIN", "SUCCEEDED")).toBe(true);
      expect(isPaymentTransitionAllowed("PAYOUT_UNCERTAIN", "FAILED")).toBe(true);
    });

    it("allows RECONCILIATION_REQUIRED -> SUCCEEDED, FAILED", () => {
      expect(isPaymentTransitionAllowed("RECONCILIATION_REQUIRED", "SUCCEEDED")).toBe(true);
      expect(isPaymentTransitionAllowed("RECONCILIATION_REQUIRED", "FAILED")).toBe(true);
    });

    it("enforces terminal states: SUCCEEDED and FAILED", () => {
      expect(ALLOWED_PAYMENT_TRANSITIONS.SUCCEEDED).toEqual([]);
      expect(ALLOWED_PAYMENT_TRANSITIONS.FAILED).toEqual([]);

      for (const target of PAYMENT_TX_STATUSES) {
        expect(isPaymentTransitionAllowed("SUCCEEDED", target)).toBe(false);
        expect(() => validatePaymentTransition("SUCCEEDED", target)).toThrow(
          InvalidStateTransitionError
        );

        expect(isPaymentTransitionAllowed("FAILED", target)).toBe(false);
        expect(() => validatePaymentTransition("FAILED", target)).toThrow(
          InvalidStateTransitionError
        );
      }
    });

    it("strictly disallows illegal and skipped transitions", () => {
      // Skipping RESERVED
      expect(isPaymentTransitionAllowed("CREATED", "PROCESSING")).toBe(false);
      expect(() => validatePaymentTransition("CREATED", "PROCESSING")).toThrow(
        InvalidStateTransitionError
      );

      // No direct RESERVED -> RECONCILIATION_REQUIRED (stalled RESERVED must be claimed via RESERVED -> PROCESSING)
      expect(isPaymentTransitionAllowed("RESERVED", "RECONCILIATION_REQUIRED")).toBe(false);
      expect(() => validatePaymentTransition("RESERVED", "RECONCILIATION_REQUIRED")).toThrow(
        InvalidStateTransitionError
      );

      // Direct RESERVED -> SUCCEEDED is impossible (must process through gateway)
      expect(isPaymentTransitionAllowed("RESERVED", "SUCCEEDED")).toBe(false);

      // Direct PROCESSING -> RECONCILIATION_REQUIRED is impossible (must flag PAYOUT_UNCERTAIN first)
      expect(isPaymentTransitionAllowed("PROCESSING", "RECONCILIATION_REQUIRED")).toBe(false);

      // No looping backwards
      expect(isPaymentTransitionAllowed("PROCESSING", "CREATED")).toBe(false);
      expect(isPaymentTransitionAllowed("PROCESSING", "RESERVED")).toBe(false);
      expect(isPaymentTransitionAllowed("RECONCILIATION_REQUIRED", "PROCESSING")).toBe(false);
    });
  });

  describe("assertDecoupledStateMachines", () => {
    it("passes for valid milestone and payment statuses", () => {
      expect(() =>
        assertDecoupledStateMachines("ELIGIBLE_FOR_PAYOUT", "RESERVED")
      ).not.toThrow();
      expect(() =>
        assertDecoupledStateMachines("SUBMITTED", "CREATED")
      ).not.toThrow();
    });

    it("rejects when milestone status is invalid or from payment domain", () => {
      expect(() =>
        assertDecoupledStateMachines("RESERVED", "PROCESSING")
      ).toThrow(/Invalid milestone status/);

      expect(() =>
        assertDecoupledStateMachines("PAID", "SUCCEEDED")
      ).toThrow(/Invalid milestone status/);
    });

    it("rejects when payment status is invalid or from milestone domain", () => {
      expect(() =>
        assertDecoupledStateMachines("ELIGIBLE_FOR_PAYOUT", "ELIGIBLE_FOR_PAYOUT")
      ).toThrow(/Invalid payment status/);

      expect(() =>
        assertDecoupledStateMachines("FUNDED", "UNKNOWN_STATUS")
      ).toThrow(/Invalid payment status/);
    });
  });
});
