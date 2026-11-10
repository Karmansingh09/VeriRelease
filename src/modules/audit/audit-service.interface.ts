/**
 * VeriRelease Audit Service Interface
 *
 * Defines the application boundary for transactional audit event recording,
 * actor attribution enforcement, and canonical payload hashing.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type { AuditEntityType, AuditActorType, AuditLog } from "./types";

export interface RecordAuditEventInput {
  id?: string;
  entityType: AuditEntityType;
  entityId: string;
  actorType: AuditActorType | "SYSTEM";
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
  action: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  correlationId?: string;
  timestamp?: Date;
  hash?: string | null;
  eventHash?: string | null;
  auditHash?: string | null;
}

export interface RecordAuditEventResult {
  auditLog: AuditLog;
  eventHash: string;
}

export interface AuditServiceOptions {
  tx?: PrismaTransactionClient;
}

export interface AuditService {
  /**
   * Validates actor attribution, canonicalizes metadata, computes the authoritative event hash,
   * and persists the append-only AuditLog record within the caller's transaction context.
   */
  recordEvent(
    input: RecordAuditEventInput,
    options?: AuditServiceOptions
  ): Promise<RecordAuditEventResult>;

  /**
   * Deterministically computes the RFC 8785 canonical JSON SHA-256 hash of an event payload.
   */
  computeEventHash(input: RecordAuditEventInput): string;

  /**
   * Retrieves all audit logs for a given entity ordered chronologically.
   */
  getEventsForEntity(
    entityType: AuditEntityType,
    entityId: string,
    options?: AuditServiceOptions
  ): Promise<AuditLog[]>;

  /**
   * Retrieves all audit logs associated with a correlation ID.
   */
  getEventsByCorrelationId(
    correlationId: string,
    options?: AuditServiceOptions
  ): Promise<AuditLog[]>;
}
