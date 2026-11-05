/**
 * VeriRelease Milestone State Machine
 *
 * Pure, deterministic verification state machine tracking milestone deliverables.
 *
 * CRITICAL ARCHITECTURAL BOUNDARIES:
 * - Payment states are strictly excluded.
 * - ELIGIBLE_FOR_PAYOUT represents deterministic policy approval only, NOT payment completion.
 * - AI evaluates evidence; deterministic logic authorizes; PayPal executes payment.
 * - DISPUTED is a terminal halt state in Milestone 2.
 */

import {
  InvalidStateTransitionError,
  UnauthorizedActorError,
  DomainValidationError,
} from "../common/errors";
import { type MilestoneStatus, type Milestone } from "./types";

export type MilestoneActor = "CLIENT" | "DEVELOPER" | "ADMIN" | "SYSTEM";

/**
 * Deterministic transition graph for Milestone verification lifecycle.
 */
export const ALLOWED_MILESTONE_TRANSITIONS: Record<
  MilestoneStatus,
  readonly MilestoneStatus[]
> = {
  DRAFT: ["FUNDED", "CANCELLED", "DISPUTED"],
  FUNDED: ["SUBMITTED", "CANCELLED", "DISPUTED"],
  SUBMITTED: ["EVALUATING", "DISPUTED"],
  EVALUATING: ["ELIGIBLE_FOR_PAYOUT", "CHANGES_REQUESTED", "DISPUTED"],
  ELIGIBLE_FOR_PAYOUT: ["DISPUTED"],
  CHANGES_REQUESTED: ["SUBMITTED", "DISPUTED"],
  DISPUTED: [], // Terminal halt state in Milestone 2
  CANCELLED: [], // Terminal state
};

/**
 * Mapping of transition keys to authorized actors.
 */
export const MILESTONE_TRANSITION_ACTORS: Record<
  string,
  readonly MilestoneActor[]
> = {
  "DRAFT->FUNDED": ["CLIENT"],
  "DRAFT->CANCELLED": ["CLIENT", "ADMIN"],
  "FUNDED->SUBMITTED": ["DEVELOPER"],
  "FUNDED->CANCELLED": ["CLIENT", "ADMIN"],
  "SUBMITTED->EVALUATING": ["SYSTEM"], // Strictly automated harvester
  "EVALUATING->ELIGIBLE_FOR_PAYOUT": ["SYSTEM"], // Strictly policy engine
  "EVALUATING->CHANGES_REQUESTED": ["SYSTEM"], // Strictly policy engine
  "CHANGES_REQUESTED->SUBMITTED": ["DEVELOPER"],
  // Disputes can be lodged by client or developer from any non-terminal state
  "DRAFT->DISPUTED": ["CLIENT", "DEVELOPER"],
  "FUNDED->DISPUTED": ["CLIENT", "DEVELOPER"],
  "SUBMITTED->DISPUTED": ["CLIENT", "DEVELOPER"],
  "EVALUATING->DISPUTED": ["CLIENT", "DEVELOPER"],
  "ELIGIBLE_FOR_PAYOUT->DISPUTED": ["CLIENT", "DEVELOPER"],
  "CHANGES_REQUESTED->DISPUTED": ["CLIENT", "DEVELOPER"],
};

/**
 * Mapping of transitions to emitted audit actions.
 */
export const MILESTONE_AUDIT_ACTIONS: Record<string, string> = {
  "DRAFT->FUNDED": "MILESTONE_FUNDED",
  "DRAFT->CANCELLED": "MILESTONE_CANCELLED",
  "FUNDED->SUBMITTED": "MILESTONE_SUBMITTED",
  "FUNDED->CANCELLED": "MILESTONE_CANCELLED",
  "SUBMITTED->EVALUATING": "EVALUATION_STARTED",
  "EVALUATING->ELIGIBLE_FOR_PAYOUT": "POLICY_EVALUATION_APPROVED",
  "EVALUATING->CHANGES_REQUESTED": "CHANGES_REQUESTED",
  "CHANGES_REQUESTED->SUBMITTED": "MILESTONE_RESUBMITTED",
  "DRAFT->DISPUTED": "MILESTONE_DISPUTED",
  "FUNDED->DISPUTED": "MILESTONE_DISPUTED",
  "SUBMITTED->DISPUTED": "MILESTONE_DISPUTED",
  "EVALUATING->DISPUTED": "MILESTONE_DISPUTED",
  "ELIGIBLE_FOR_PAYOUT->DISPUTED": "MILESTONE_DISPUTED",
  "CHANGES_REQUESTED->DISPUTED": "MILESTONE_DISPUTED",
};

/**
 * Pure check whether a milestone state transition is structurally allowed.
 */
export function isMilestoneTransitionAllowed(
  from: MilestoneStatus,
  to: MilestoneStatus
): boolean {
  const allowed = ALLOWED_MILESTONE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Contextual parameters for transition verification.
 */
export interface MilestoneTransitionContext {
  milestone: Pick<Milestone, "id" | "status" | "amountMinorUnits">;
  targetStatus: MilestoneStatus;
  actor: MilestoneActor;
  // Specific contextual payloads for invariants
  activeCriteriaCount?: number;
  prNumber?: number;
  prCommitSha?: string;
  priorCommitSha?: string;
  disputeReason?: string;
}

export interface MilestoneTransitionResult {
  previousStatus: MilestoneStatus;
  newStatus: MilestoneStatus;
  auditAction: string;
}

/**
 * Pure, deterministic function to validate and execute a milestone transition.
 *
 * @throws {InvalidStateTransitionError} If transition is disallowed by state graph.
 * @throws {UnauthorizedActorError} If actor is not permitted to trigger this transition.
 * @throws {DomainValidationError} If transition-specific preconditions fail.
 */
export function transitionMilestone(
  context: MilestoneTransitionContext
): MilestoneTransitionResult {
  const { milestone, targetStatus, actor } = context;
  const currentStatus = milestone.status;
  const transitionKey = `${currentStatus}->${targetStatus}`;

  // 1. Graph transition check
  if (!isMilestoneTransitionAllowed(currentStatus, targetStatus)) {
    throw new InvalidStateTransitionError(
      currentStatus,
      targetStatus,
      "Milestone",
      `Transition is not permitted by milestone verification state graph`
    );
  }

  // 2. Authorization check
  const authorizedActors = MILESTONE_TRANSITION_ACTORS[transitionKey];
  if (!authorizedActors || !authorizedActors.includes(actor)) {
    throw new UnauthorizedActorError(
      actor,
      `transition from '${currentStatus}' to '${targetStatus}'`,
      authorizedActors
    );
  }

  // 3. Transition-specific domain invariants
  switch (transitionKey) {
    case "DRAFT->FUNDED": {
      if (milestone.amountMinorUnits <= 0n) {
        throw new DomainValidationError(
          `Cannot fund milestone: amountMinorUnits must be positive (> 0), got: ${milestone.amountMinorUnits}`
        );
      }
      if (context.activeCriteriaCount === undefined || context.activeCriteriaCount === null) {
        throw new DomainValidationError(
          `Cannot fund milestone: activeCriteriaCount is mandatory for funding`
        );
      }
      if (
        typeof context.activeCriteriaCount !== "number" ||
        !Number.isInteger(context.activeCriteriaCount) ||
        context.activeCriteriaCount < 1
      ) {
        throw new DomainValidationError(
          `Cannot fund milestone: at least 1 active criterion is required, got: ${context.activeCriteriaCount}`
        );
      }
      break;
    }

    case "FUNDED->SUBMITTED": {
      if (!context.prNumber || context.prNumber <= 0) {
        throw new DomainValidationError(
          `Cannot submit milestone: PR number must be positive (> 0), got: ${context.prNumber}`
        );
      }
      if (!context.prCommitSha || !/^[0-9a-f]{40}$/.test(context.prCommitSha)) {
        throw new DomainValidationError(
          `Cannot submit milestone: commit SHA must be 40 lowercase hexadecimal characters, got: '${context.prCommitSha}'`
        );
      }
      break;
    }

    case "CHANGES_REQUESTED->SUBMITTED": {
      if (!context.prNumber || context.prNumber <= 0) {
        throw new DomainValidationError(
          `Cannot resubmit milestone: PR number must be positive (> 0), got: ${context.prNumber}`
        );
      }
      if (!context.priorCommitSha) {
        throw new DomainValidationError(
          `Cannot resubmit milestone: priorCommitSha is mandatory for resubmission from CHANGES_REQUESTED`
        );
      }
      if (!/^[0-9a-f]{40}$/.test(context.priorCommitSha)) {
        throw new DomainValidationError(
          `Cannot resubmit milestone: priorCommitSha must be 40 lowercase hexadecimal characters, got: '${context.priorCommitSha}'`
        );
      }
      if (!context.prCommitSha || !/^[0-9a-f]{40}$/.test(context.prCommitSha)) {
        throw new DomainValidationError(
          `Cannot resubmit milestone: commit SHA must be 40 lowercase hexadecimal characters, got: '${context.prCommitSha}'`
        );
      }
      if (context.prCommitSha.toLowerCase() === context.priorCommitSha.toLowerCase()) {
        throw new DomainValidationError(
          `Cannot resubmit milestone: new commit SHA must differ from the previously rejected commit SHA (${context.priorCommitSha})`
        );
      }
      break;
    }

    default: {
      if (targetStatus === "DISPUTED") {
        const reason = context.disputeReason?.trim();
        if (!reason || reason.length < 20) {
          throw new DomainValidationError(
            `Dispute reason must be at least 20 characters long, got ${reason ? reason.length : 0}`
          );
        }
      }
      break;
    }
  }

  const auditAction = MILESTONE_AUDIT_ACTIONS[transitionKey] ?? "MILESTONE_STATUS_UPDATED";

  return {
    previousStatus: currentStatus,
    newStatus: targetStatus,
    auditAction,
  };
}
