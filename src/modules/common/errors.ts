/**
 * VeriRelease Domain Errors
 * Strongly typed error hierarchy for domain validation, state transitions,
 * money operations, and concurrency control.
 */

export abstract class DomainError extends Error {
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Capture stack trace if available in current runtime
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when an illegal state transition is attempted on a state machine.
 */
export class InvalidStateTransitionError extends DomainError {
  public override readonly code = "INVALID_STATE_TRANSITION" as const;

  constructor(
    public readonly fromState: string,
    public readonly toState: string,
    public readonly entityType?: string,
    public readonly reason?: string
  ) {
    const entityPrefix = entityType ? `[${entityType}] ` : "";
    const reasonSuffix = reason ? `: ${reason}` : "";
    super(
      `${entityPrefix}Invalid state transition from '${fromState}' to '${toState}'${reasonSuffix}`
    );
  }
}

/**
 * Thrown when a currency code is not in the supported ISO 4217 subset.
 */
export class UnsupportedCurrencyError extends DomainError {
  public override readonly code = "UNSUPPORTED_CURRENCY" as const;

  constructor(public readonly currency: string) {
    super(`Unsupported currency '${currency}'. Must be one of the supported ISO 4217 currencies.`);
  }
}

/**
 * Thrown when monetary values or minor unit calculations are invalid.
 */
export class InvalidMoneyError extends DomainError {
  public override readonly code = "INVALID_MONEY" as const;

  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when an actor attempts an action they are not authorized to perform.
 */
export class UnauthorizedActorError extends DomainError {
  public override readonly code = "UNAUTHORIZED_ACTOR" as const;

  constructor(
    public readonly actor: string,
    public readonly action: string,
    public readonly authorizedActors?: readonly string[]
  ) {
    const authorizedList = authorizedActors ? ` Allowed actors: ${authorizedActors.join(", ")}.` : "";
    super(`Actor '${actor}' is not authorized to perform '${action}'.${authorizedList}`);
  }
}

/**
 * Thrown when domain validation invariants fail (e.g., malformed commit SHA, negative amounts).
 */
export class DomainValidationError extends DomainError {
  public override readonly code = "DOMAIN_VALIDATION_ERROR" as const;

  constructor(message: string, public readonly details?: unknown) {
    super(message);
  }
}

/**
 * Thrown when an expected domain entity does not exist.
 */
export class DomainNotFoundError extends DomainError {
  public override readonly code = "DOMAIN_NOT_FOUND" as const;

  constructor(public readonly entity: string, public readonly entityId?: string) {
    const idSuffix = entityId ? ` with id '${entityId}'` : "";
    super(`${entity}${idSuffix} not found.`);
  }
}

/**
 * Thrown when a concurrency conflict or lock contention occurs.
 */
export class ConcurrencyConflictError extends DomainError {
  public override readonly code = "CONCURRENCY_CONFLICT" as const;

  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when an operation would create a duplicate successful payout for a milestone.
 */
export class DuplicatePayoutError extends DomainError {
  public override readonly code = "DUPLICATE_PAYOUT" as const;

  constructor(message: string) {
    super(message);
  }
}
