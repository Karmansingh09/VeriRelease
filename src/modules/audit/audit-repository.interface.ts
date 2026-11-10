/**
 * VeriRelease Audit Repository Interface
 *
 * Defines the persistence boundary for append-only AuditLog records.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type { AuditEntityType, AuditActorType, AuditLog } from "./types";

export interface CreateAuditLogInput {
  id?: string;
  entityType: AuditEntityType;
  entityId: string;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
  action: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  correlationId: string;
  timestamp?: Date;
}

export interface AuditRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface AuditRepository {
  /**
   * Persists an append-only audit log record.
   */
  createAuditLog(
    input: CreateAuditLogInput,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog>;

  /**
   * Retrieves an audit log record by its unique ID.
   */
  findById(
    id: string,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog | null>;

  /**
   * Retrieves all audit logs for a specific entity ordered chronologically.
   */
  findByEntity(
    entityType: AuditEntityType,
    entityId: string,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog[]>;

  /**
   * Retrieves all audit logs matching a correlation ID.
   */
  findByCorrelationId(
    correlationId: string,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog[]>;
}
