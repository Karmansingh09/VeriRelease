/**
 * VeriRelease Payment State Machine
 *
 * Deterministic transition validation for Payment Transactions.
 * Strictly decoupled from Milestone verification state machine.
 */

import { InvalidStateTransitionError } from "../common/errors";
import {
  type PaymentTxStatus,
  PAYMENT_TX_STATUSES,
} from "./types";
import {
  MILESTONE_STATUSES,
} from "../contracts/types";

// ==========================================
// Allowed Payment State Machine Transition Graph
// ==========================================

export const ALLOWED_PAYMENT_TRANSITIONS: Record<
  PaymentTxStatus,
  readonly PaymentTxStatus[]
> = {
  CREATED: ["RESERVED"],
  RESERVED: ["PROCESSING"],
  PROCESSING: ["SUCCEEDED", "FAILED", "PAYOUT_UNCERTAIN"],
  PAYOUT_UNCERTAIN: ["RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [], // Terminal
  FAILED: [], // Terminal
};

/**
 * Returns true if the payment transition from `from` to `to` is permitted.
 */
export function isPaymentTransitionAllowed(
  from: PaymentTxStatus,
  to: PaymentTxStatus
): boolean {
  const allowed = ALLOWED_PAYMENT_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

/**
 * Validates a payment state transition.
 * Throws InvalidStateTransitionError if the transition is prohibited.
 */
export function validatePaymentTransition(
  from: PaymentTxStatus,
  to: PaymentTxStatus
): void {
  if (!isPaymentTransitionAllowed(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Asserts that milestone verification states and payment transaction states
 * remain completely independent and decoupled with no namespace overlap.
 */
export function assertDecoupledStateMachines(
  milestoneStatus: unknown,
  paymentStatus: unknown
): void {
  const validMilestone =
    typeof milestoneStatus === "string" &&
    (MILESTONE_STATUSES as readonly string[]).includes(milestoneStatus);
  const validPayment =
    typeof paymentStatus === "string" &&
    (PAYMENT_TX_STATUSES as readonly string[]).includes(paymentStatus);

  if (!validMilestone) {
    throw new Error(
      `Invalid milestone status '${String(milestoneStatus)}': not a recognized MilestoneStatus`
    );
  }

  if (!validPayment) {
    throw new Error(
      `Invalid payment status '${String(paymentStatus)}': not a recognized PaymentTxStatus`
    );
  }
}
