/**
 * VeriRelease Prisma Audit Repository Implementation
 *
 * Implements append-only AuditLog persistence adhering to database immutability triggers
 * and actor consistency constraints.
 */

import { randomUUID } from "node:crypto";
import {
  prisma,
  type DbClient,
  type PrismaClient,
  type PrismaTransactionClient,
} from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { DomainValidationError } from "../common/errors";
import type { AuditEntityType, AuditActorType, AuditLog } from "./types";
import type {
  AuditRepository,
  CreateAuditLogInput,
  AuditRepositoryOptions,
} from "./audit-repository.interface";

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: AuditRepositoryOptions): PrismaClient | PrismaTransactionClient {
    return options?.tx ?? (this.client as PrismaClient);
  }

  async createAuditLog(
    input: CreateAuditLogInput,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog> {
    const db = this.getClient(options);

    // Validate actor consistency invariant: chk_audit_actor_consistency
    if (input.actorType === "USER") {
      if (!input.actorUserId || input.actorUserId.trim() === "") {
        throw new DomainValidationError(
          "Actor consistency violation: actorType 'USER' requires non-null actorUserId"
        );
      }
      if (input.actorSystemPrincipal) {
        throw new DomainValidationError(
          "Actor consistency violation: actorType 'USER' prohibits actorSystemPrincipal"
        );
      }
    } else {
      if (!input.actorSystemPrincipal || input.actorSystemPrincipal.trim() === "") {
        throw new DomainValidationError(
          `Actor consistency violation: actorType '${input.actorType}' requires non-null actorSystemPrincipal`
        );
      }
      if (input.actorUserId) {
        throw new DomainValidationError(
          `Actor consistency violation: actorType '${input.actorType}' prohibits actorUserId`
        );
      }
    }

    const id = input.id ?? `aud_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const timestamp = input.timestamp ?? new Date();

    const row = await db.auditLog.create({
      data: {
        id,
        entityType: input.entityType,
        entityId: input.entityId,
        actorType: input.actorType,
        actorUserId: input.actorUserId ?? null,
        actorSystemPrincipal: input.actorSystemPrincipal ?? null,
        action: input.action,
        previousState:
          input.previousState !== undefined && input.previousState !== null
            ? (input.previousState as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        newState:
          input.newState !== undefined && input.newState !== null
            ? (input.newState as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        metadata:
          input.metadata !== undefined && input.metadata !== null
            ? (input.metadata as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        correlationId: input.correlationId,
        timestamp,
      },
    });

    return this.mapToDomain(row);
  }

  async findById(
    id: string,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog | null> {
    const db = this.getClient(options);
    const row = await db.auditLog.findUnique({
      where: { id },
    });
    return row ? this.mapToDomain(row) : null;
  }

  async findByEntity(
    entityType: AuditEntityType,
    entityId: string,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog[]> {
    const db = this.getClient(options);
    const rows = await db.auditLog.findMany({
      where: {
        entityType,
        entityId,
      },
      orderBy: {
        timestamp: "asc",
      },
    });
    return rows.map((r) => this.mapToDomain(r));
  }

  async findByCorrelationId(
    correlationId: string,
    options?: AuditRepositoryOptions
  ): Promise<AuditLog[]> {
    const db = this.getClient(options);
    const rows = await db.auditLog.findMany({
      where: {
        correlationId,
      },
      orderBy: {
        timestamp: "asc",
      },
    });
    return rows.map((r) => this.mapToDomain(r));
  }

  private mapToDomain(row: {
    id: string;
    entityType: string;
    entityId: string;
    actorType: string;
    actorUserId: string | null;
    actorSystemPrincipal: string | null;
    action: string;
    previousState: unknown;
    newState: unknown;
    metadata: unknown;
    correlationId: string;
    timestamp: Date;
  }): AuditLog {
    return {
      id: row.id,
      entityType: row.entityType as AuditEntityType,
      entityId: row.entityId,
      actorType: row.actorType as AuditActorType,
      actorUserId: row.actorUserId,
      actorSystemPrincipal: row.actorSystemPrincipal,
      action: row.action,
      previousState: (row.previousState as Record<string, unknown> | null) ?? null,
      newState: (row.newState as Record<string, unknown> | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      correlationId: row.correlationId,
      timestamp: row.timestamp,
    };
  }
}
