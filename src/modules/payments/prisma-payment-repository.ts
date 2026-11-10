/**
 * VeriRelease Prisma Payment Repository Implementation
 *
 * Implements atomic, parameterized PaymentTransaction operations adhering
 * to database foreign keys, attempt allocation, and conditional state updates.
 */

import { randomUUID } from "node:crypto";
import {
  prisma,
  type DbClient,
  type PrismaClient,
  type PrismaTransactionClient,
} from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import {
  ConcurrencyConflictError,
  DomainNotFoundError,
} from "../common/errors";
import type { SupportedCurrency } from "../common/money";
import type {
  PaymentTransaction,
  PaymentTxType,
  PaymentTxStatus,
} from "./types";
import type {
  PaymentRepository,
  CreatePaymentTransactionInput,
  UpdatePaymentTransactionData,
  PaymentRepositoryOptions,
} from "./payment-repository.interface";

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: PaymentRepositoryOptions): PrismaClient | PrismaTransactionClient {
    return options?.tx ?? (this.client as PrismaClient);
  }

  async createTransaction(
    input: CreatePaymentTransactionInput,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction> {
    const db = this.getClient(options);

    const id = input.id ?? `tx_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const row = await db.paymentTransaction.create({
      data: {
        id,
        milestoneId: input.milestoneId,
        submissionId: input.submissionId ?? null,
        transactionType: input.transactionType,
        status: input.status ?? "CREATED",
        idempotencyKey: input.idempotencyKey,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        attemptNumber: input.attemptNumber,
        paypalOrderId: input.paypalOrderId ?? null,
        paypalCaptureId: input.paypalCaptureId ?? null,
        paypalPayoutBatchId: input.paypalPayoutBatchId ?? null,
        paypalPayoutItemId: input.paypalPayoutItemId ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        rawRequest:
          input.rawRequest !== undefined && input.rawRequest !== null
            ? (input.rawRequest as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        rawResponse:
          input.rawResponse !== undefined && input.rawResponse !== null
            ? (input.rawResponse as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
      },
    });

    return this.mapToDomain(row);
  }

  async updateStatus(
    id: string,
    milestoneId: string,
    fromStatus: PaymentTxStatus,
    toStatus: PaymentTxStatus,
    data?: UpdatePaymentTransactionData,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction> {
    const db = this.getClient(options);

    const rawResponseVal =
      data?.rawResponse !== undefined && data.rawResponse !== null
        ? JSON.stringify(data.rawResponse)
        : null;

    const rowsAffected = await db.$executeRaw`
      UPDATE "PaymentTransaction"
      SET "status" = ${toStatus}::"PaymentTxStatus",
          "errorCode" = COALESCE(${data?.errorCode ?? null}, "errorCode"),
          "errorMessage" = COALESCE(${data?.errorMessage ?? null}, "errorMessage"),
          "paypalOrderId" = COALESCE(${data?.paypalOrderId ?? null}, "paypalOrderId"),
          "paypalCaptureId" = COALESCE(${data?.paypalCaptureId ?? null}, "paypalCaptureId"),
          "paypalPayoutBatchId" = COALESCE(${data?.paypalPayoutBatchId ?? null}, "paypalPayoutBatchId"),
          "paypalPayoutItemId" = COALESCE(${data?.paypalPayoutItemId ?? null}, "paypalPayoutItemId"),
          "rawResponse" = CASE 
            WHEN ${rawResponseVal}::text IS NOT NULL 
            THEN ${rawResponseVal}::jsonb 
            ELSE "rawResponse" 
          END,
          "updatedAt" = NOW()
      WHERE "id" = ${id} 
        AND "milestoneId" = ${milestoneId}
        AND "status" = ${fromStatus}::"PaymentTxStatus";
    `;

    if (rowsAffected !== 1) {
      throw new ConcurrencyConflictError(
        `Payment transaction ${id} could not transition from '${fromStatus}' to '${toStatus}'. Status already altered or record locked by another worker.`
      );
    }

    const updated = await this.findById(id, options);
    if (!updated) {
      throw new DomainNotFoundError("PaymentTransaction", id);
    }
    return updated;
  }

  async findById(
    id: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null> {
    const db = this.getClient(options);
    const row = await db.paymentTransaction.findUnique({
      where: { id },
    });
    return row ? this.mapToDomain(row) : null;
  }

  async findByIdempotencyKey(
    key: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null> {
    const db = this.getClient(options);
    const row = await db.paymentTransaction.findUnique({
      where: { idempotencyKey: key },
    });
    return row ? this.mapToDomain(row) : null;
  }

  async findActiveByMilestoneId(
    milestoneId: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null> {
    const db = this.getClient(options);
    const row = await db.paymentTransaction.findFirst({
      where: {
        milestoneId,
        status: {
          in: ["RESERVED", "PROCESSING", "PAYOUT_UNCERTAIN", "RECONCILIATION_REQUIRED"],
        },
      },
    });
    return row ? this.mapToDomain(row) : null;
  }

  async findSucceededPayoutByMilestoneId(
    milestoneId: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction | null> {
    const db = this.getClient(options);
    const row = await db.paymentTransaction.findFirst({
      where: {
        milestoneId,
        transactionType: "PAYOUT",
        status: "SUCCEEDED",
      },
    });
    return row ? this.mapToDomain(row) : null;
  }

  async findByMilestoneId(
    milestoneId: string,
    options?: PaymentRepositoryOptions
  ): Promise<PaymentTransaction[]> {
    const db = this.getClient(options);
    const rows = await db.paymentTransaction.findMany({
      where: { milestoneId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.mapToDomain(r));
  }

  async getNextAttemptNumber(
    milestoneId: string,
    transactionType: PaymentTxType,
    options?: PaymentRepositoryOptions
  ): Promise<number> {
    const db = this.getClient(options);
    const rows = await db.$queryRaw<Array<{ nextAttempt: number }>>`
      SELECT COALESCE(MAX("attemptNumber"), 0) + 1 AS "nextAttempt"
      FROM "PaymentTransaction"
      WHERE "milestoneId" = ${milestoneId} AND "transactionType" = ${transactionType}::"PaymentTxType";
    `;
    return rows[0]?.nextAttempt ?? 1;
  }

  private mapToDomain(row: {
    id: string;
    milestoneId: string;
    submissionId: string | null;
    transactionType: string;
    status: string;
    idempotencyKey: string;
    amountMinorUnits: bigint;
    currency: string;
    attemptNumber: number;
    paypalOrderId: string | null;
    paypalCaptureId: string | null;
    paypalPayoutBatchId: string | null;
    paypalPayoutItemId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    rawRequest: unknown;
    rawResponse: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentTransaction {
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      submissionId: row.submissionId,
      transactionType: row.transactionType as PaymentTxType,
      status: row.status as PaymentTxStatus,
      idempotencyKey: row.idempotencyKey,
      amountMinorUnits: BigInt(row.amountMinorUnits),
      currency: row.currency as SupportedCurrency,
      attemptNumber: row.attemptNumber,
      paypalOrderId: row.paypalOrderId,
      paypalCaptureId: row.paypalCaptureId,
      paypalPayoutBatchId: row.paypalPayoutBatchId,
      paypalPayoutItemId: row.paypalPayoutItemId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      rawRequest: (row.rawRequest as Record<string, unknown> | null) ?? null,
      rawResponse: (row.rawResponse as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
