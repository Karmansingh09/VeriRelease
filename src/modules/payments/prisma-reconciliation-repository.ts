/**
 * VeriRelease Prisma Payment Reconciliation Repository Implementation
 *
 * Persists append-only PaymentReconciliation records adhering to
 * database foreign keys, check constraints, and immutability triggers.
 */

import { randomUUID } from "node:crypto";
import {
  prisma,
  type DbClient,
  type PrismaClient,
  type PrismaTransactionClient,
} from "../../lib/prisma";
import type {
  PaymentReconciliation,
  ReconciliationDecision,
  ReconciliationActorType,
} from "./types";
import type {
  ReconciliationRepository,
  CreatePaymentReconciliationInput,
  ReconciliationRepositoryOptions,
} from "./reconciliation-repository.interface";
import type { AuditActorType } from "@prisma/client";

export class PrismaReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(
    options?: ReconciliationRepositoryOptions
  ): PrismaClient | PrismaTransactionClient {
    return options?.tx ?? (this.client as PrismaClient);
  }

  async createReconciliation(
    input: CreatePaymentReconciliationInput,
    options?: ReconciliationRepositoryOptions
  ): Promise<PaymentReconciliation> {
    const db = this.getClient(options);

    const id = input.id ?? `rec_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // Normalize actorType: "SYSTEM" -> "SYSTEM_PRINCIPAL"
    const prismaActorType: AuditActorType =
      input.actorType === "SYSTEM" ? "SYSTEM_PRINCIPAL" : (input.actorType as AuditActorType);

    const row = await db.paymentReconciliation.create({
      data: {
        id,
        paymentTransactionId: input.paymentTransactionId,
        decision: input.decision,
        reason: input.reason,
        evidenceReference: input.evidenceReference ?? null,
        evidenceType: input.evidenceType ?? null,
        actorType: prismaActorType,
        actorUserId: input.actorUserId ?? null,
        actorSystemPrincipal: input.actorSystemPrincipal ?? null,
        createdAt: input.createdAt ?? new Date(),
      },
    });

    return this.mapToDomain(row);
  }

  async findById(
    id: string,
    options?: ReconciliationRepositoryOptions
  ): Promise<PaymentReconciliation | null> {
    const db = this.getClient(options);
    const row = await db.paymentReconciliation.findUnique({
      where: { id },
    });
    return row ? this.mapToDomain(row) : null;
  }

  async findByPaymentTransactionId(
    paymentTransactionId: string,
    options?: ReconciliationRepositoryOptions
  ): Promise<PaymentReconciliation[]> {
    const db = this.getClient(options);
    const rows = await db.paymentReconciliation.findMany({
      where: { paymentTransactionId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.mapToDomain(r));
  }

  private mapToDomain(row: {
    id: string;
    paymentTransactionId: string;
    decision: string;
    reason: string;
    evidenceReference: string | null;
    evidenceType: string | null;
    actorType: string;
    actorUserId: string | null;
    actorSystemPrincipal: string | null;
    createdAt: Date;
  }): PaymentReconciliation {
    return {
      id: row.id,
      paymentTransactionId: row.paymentTransactionId,
      decision: row.decision as ReconciliationDecision,
      reason: row.reason,
      evidenceReference: row.evidenceReference,
      evidenceType: row.evidenceType,
      actorType: row.actorType as ReconciliationActorType,
      actorUserId: row.actorUserId,
      actorSystemPrincipal: row.actorSystemPrincipal,
      createdAt: row.createdAt,
    };
  }
}
