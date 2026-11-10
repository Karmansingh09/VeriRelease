/**
 * VeriRelease Transactional Audit Service Implementation
 *
 * Enforces typed actor attribution, recursive canonical JSON metadata validation,
 * deterministic RFC 8785 event hashing, and transactional append-only persistence.
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "../../lib/prisma";
import { canonicalizeJson, hashCanonicalJson } from "../common/canonical-json";
import { DomainNotFoundError, DomainValidationError } from "../common/errors";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_ENTITY_TYPES,
  type AuditActorType,
  type AuditEntityType,
  type AuditLog,
} from "./types";
import type { AuditRepository } from "./audit-repository.interface";
import { PrismaAuditRepository } from "./prisma-audit-repository";
import type {
  AuditService,
  RecordAuditEventInput,
  RecordAuditEventResult,
  AuditServiceOptions,
} from "./audit-service.interface";

export interface ComputeAuditHashInput {
  id?: string | null;
  entityType: string;
  entityId: string;
  actorType: string;
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
  action: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  correlationId: string;
  timestamp: Date | string;
}

/**
 * Pure, deterministic computation of an audit event's RFC 8785 canonical JSON SHA-256 hash.
 * Recursively validates that metadata, previousState, and newState are safe canonical JSON.
 */
export function computeAuditHash(input: ComputeAuditHashInput): string {
  let sanitizedMetadata: Record<string, unknown> | null = null;
  if (input.metadata !== undefined && input.metadata !== null) {
    if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new DomainValidationError("Audit metadata must be a JSON object");
    }
    sanitizedMetadata = { ...input.metadata };
    delete sanitizedMetadata.eventHash;
    delete sanitizedMetadata.auditHash;
    canonicalizeJson(sanitizedMetadata);
  }

  if (input.previousState !== undefined && input.previousState !== null) {
    if (typeof input.previousState !== "object" || Array.isArray(input.previousState)) {
      throw new DomainValidationError("previousState must be a JSON object");
    }
    canonicalizeJson(input.previousState);
  }

  if (input.newState !== undefined && input.newState !== null) {
    if (typeof input.newState !== "object" || Array.isArray(input.newState)) {
      throw new DomainValidationError("newState must be a JSON object");
    }
    canonicalizeJson(input.newState);
  }

  const payload = {
    action: input.action,
    actorSystemPrincipal: input.actorSystemPrincipal ?? null,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    correlationId: input.correlationId,
    entityId: input.entityId,
    entityType: input.entityType,
    id: input.id ?? null,
    metadata: sanitizedMetadata,
    newState: input.newState ?? null,
    previousState: input.previousState ?? null,
    timestamp:
      input.timestamp instanceof Date
        ? input.timestamp.toISOString()
        : String(input.timestamp),
  };

  return hashCanonicalJson(payload);
}

export class TransactionalAuditService implements AuditService {
  constructor(
    private readonly auditRepo: AuditRepository = new PrismaAuditRepository(prisma),
    private readonly client: DbClient = prisma
  ) {}

  async recordEvent(
    input: RecordAuditEventInput,
    options?: AuditServiceOptions
  ): Promise<RecordAuditEventResult> {
    // 1. Actor type validation
    if (!input.actorType) {
      throw new DomainValidationError("Missing actor: actorType is required");
    }

    const validActorTypes: readonly string[] = [...AUDIT_ACTOR_TYPES, "SYSTEM"];
    if (!validActorTypes.includes(input.actorType)) {
      throw new DomainValidationError(
        `Invalid actor type: '${input.actorType}'. Allowed types: ${validActorTypes.join(", ")}`
      );
    }

    // 2. Actor attribution mutual-exclusion & resolution
    let resolvedActorType: AuditActorType;
    let resolvedActorUserId: string | null = null;
    let resolvedActorSystemPrincipal: string | null = null;

    if (input.actorType === "USER") {
      if (!input.actorUserId || typeof input.actorUserId !== "string" || input.actorUserId.trim() === "") {
        throw new DomainValidationError("USER actor requires a valid non-empty actorUserId");
      }
      if (input.actorSystemPrincipal && input.actorSystemPrincipal.trim() !== "") {
        throw new DomainValidationError(
          "Both actor identities provided: USER actor cannot have actorSystemPrincipal"
        );
      }

      // Verify user existence in database
      const db = options?.tx ?? this.client;
      if ("user" in db && typeof (db as unknown as PrismaClient).user?.findUnique === "function") {
        const user = await (db as unknown as PrismaClient).user.findUnique({
          where: { id: input.actorUserId },
        });
        if (!user) {
          throw new DomainNotFoundError("User", input.actorUserId);
        }
      }

      resolvedActorType = "USER";
      resolvedActorUserId = input.actorUserId;
      resolvedActorSystemPrincipal = null;
    } else {
      // Non-USER actor (SYSTEM, SYSTEM_PRINCIPAL, WEBHOOK_GITHUB, WEBHOOK_PAYPAL)
      if (input.actorUserId && input.actorUserId.trim() !== "") {
        throw new DomainValidationError(
          `Both actor identities provided: non-USER actor '${input.actorType}' cannot have actorUserId`
        );
      }

      resolvedActorType = input.actorType === "SYSTEM" ? "SYSTEM_PRINCIPAL" : input.actorType;
      resolvedActorUserId = null;
      resolvedActorSystemPrincipal =
        input.actorSystemPrincipal && input.actorSystemPrincipal.trim() !== ""
          ? input.actorSystemPrincipal
          : input.actorType === "SYSTEM" || input.actorType === "SYSTEM_PRINCIPAL"
            ? "SYSTEM"
            : input.actorType;
    }

    // 3. Entity type and ID validation
    if (!input.entityType || !AUDIT_ENTITY_TYPES.includes(input.entityType)) {
      throw new DomainValidationError(
        `Invalid or missing entityType: '${input.entityType}'. Allowed types: ${AUDIT_ENTITY_TYPES.join(", ")}`
      );
    }
    if (!input.entityId || typeof input.entityId !== "string" || input.entityId.trim() === "") {
      throw new DomainValidationError("Audit event requires a valid non-empty entityId");
    }
    if (!input.action || typeof input.action !== "string" || input.action.trim() === "") {
      throw new DomainValidationError("Audit event requires a valid non-empty action");
    }

    // 4. Validate reserved metadata keys
    if (input.auditHash !== undefined && input.auditHash !== null) {
      throw new DomainValidationError(
        "Reserved key 'auditHash' cannot be supplied by caller. Use authoritative eventHash."
      );
    }

    if (input.metadata !== undefined && input.metadata !== null) {
      if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
        throw new DomainValidationError("Audit metadata must be a JSON object");
      }
      if ("auditHash" in input.metadata) {
        throw new DomainValidationError(
          "Reserved metadata key 'auditHash' cannot be supplied in metadata. Do not supply an unbound hash field."
        );
      }
    }

    // 5. Generate explicit identifiers and timestamp
    const id = input.id ?? `aud_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const timestamp = input.timestamp ?? new Date();
    const correlationId =
      input.correlationId ?? `corr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // 6. Authoritative hash computation (recursively validates metadata, previousState, newState)
    const authoritativeHash = computeAuditHash({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      actorType: resolvedActorType,
      actorUserId: resolvedActorUserId,
      actorSystemPrincipal: resolvedActorSystemPrincipal,
      action: input.action,
      previousState: input.previousState,
      newState: input.newState,
      metadata: input.metadata,
      correlationId,
      timestamp,
    });

    // 7. Caller-supplied hash cannot override authoritative hash
    const callerSuppliedHash =
      input.hash ??
      input.eventHash ??
      (input.metadata && typeof input.metadata === "object"
        ? (input.metadata as Record<string, unknown>).eventHash
        : undefined);

    if (callerSuppliedHash !== undefined && callerSuppliedHash !== null) {
      if (callerSuppliedHash !== authoritativeHash) {
        throw new DomainValidationError(
          `Audit hash mismatch: caller-supplied hash '${callerSuppliedHash}' does not match authoritative computed hash '${authoritativeHash}'`
        );
      }
    }

    // 8. Persist authoritative event via repository
    const persistedMetadata = {
      ...(input.metadata ?? {}),
      eventHash: authoritativeHash,
    };

    const auditLog = await this.auditRepo.createAuditLog(
      {
        id,
        entityType: input.entityType,
        entityId: input.entityId,
        actorType: resolvedActorType,
        actorUserId: resolvedActorUserId,
        actorSystemPrincipal: resolvedActorSystemPrincipal,
        action: input.action,
        previousState: input.previousState,
        newState: input.newState,
        metadata: persistedMetadata,
        correlationId,
        timestamp,
      },
      options
    );

    return {
      auditLog,
      eventHash: authoritativeHash,
    };
  }

  computeEventHash(input: RecordAuditEventInput): string {
    const resolvedActorType =
      input.actorType === "SYSTEM" ? "SYSTEM_PRINCIPAL" : input.actorType;
    const resolvedActorUserId =
      resolvedActorType === "USER" ? input.actorUserId ?? null : null;
    const resolvedActorSystemPrincipal =
      resolvedActorType === "USER"
        ? null
        : input.actorSystemPrincipal ?? (resolvedActorType === "SYSTEM_PRINCIPAL" ? "SYSTEM" : resolvedActorType);

    return computeAuditHash({
      id: input.id ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      actorType: resolvedActorType,
      actorUserId: resolvedActorUserId,
      actorSystemPrincipal: resolvedActorSystemPrincipal,
      action: input.action,
      previousState: input.previousState,
      newState: input.newState,
      metadata: input.metadata,
      correlationId: input.correlationId ?? "corr_deterministic_default",
      timestamp: input.timestamp ?? new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  async getEventsForEntity(
    entityType: AuditEntityType,
    entityId: string,
    options?: AuditServiceOptions
  ): Promise<AuditLog[]> {
    return this.auditRepo.findByEntity(entityType, entityId, options);
  }

  async getEventsByCorrelationId(
    correlationId: string,
    options?: AuditServiceOptions
  ): Promise<AuditLog[]> {
    return this.auditRepo.findByCorrelationId(correlationId, options);
  }
}

export { TransactionalAuditService as DefaultAuditService };
