/**
 * VeriRelease Prisma Webhook Delivery Repository Implementation
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type DbClient, type PrismaClient } from "../../../lib/prisma";
import type { GitHubDeliveryStatus, GitHubWebhookDelivery } from "../types";
import type {
  CreateWebhookDeliveryInput,
  WebhookDeliveryOptions,
  WebhookDeliveryRepository,
} from "./webhook-delivery.interface";

export class PrismaWebhookDeliveryRepository implements WebhookDeliveryRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: WebhookDeliveryOptions): DbClient {
    return options?.tx ?? this.client;
  }

  async create(
    input: CreateWebhookDeliveryInput,
    options?: WebhookDeliveryOptions
  ): Promise<GitHubWebhookDelivery> {
    const db = this.getClient(options);
    const id = input.id ?? `del_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const row = await db.gitHubWebhookDelivery.create({
      data: {
        id,
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        action: input.action,
        status: input.status ?? "RECEIVED",
        repositoryId: input.repositoryId,
        payload: input.payload as Prisma.InputJsonValue,
        payloadHash: input.payloadHash,
        errorMessage: input.errorMessage,
      },
    });

    return {
      id: row.id,
      deliveryId: row.deliveryId,
      eventType: row.eventType,
      action: row.action,
      status: row.status as GitHubDeliveryStatus,
      repositoryId: row.repositoryId,
      payload: row.payload as Record<string, unknown>,
      payloadHash: row.payloadHash,
      errorMessage: row.errorMessage,
      processedAt: row.processedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async createIfNotExists(
    input: CreateWebhookDeliveryInput,
    options?: WebhookDeliveryOptions
  ): Promise<{ created: boolean; delivery: GitHubWebhookDelivery }> {
    const db = this.getClient(options);
    const id = input.id ?? `del_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const status = input.status ?? "RECEIVED";
    const payloadJson = JSON.stringify(input.payload);

    // Conflict-safe INSERT using ON CONFLICT ("deliveryId") DO NOTHING RETURNING ...
    // Guarantees no Postgres unique-violation transaction abort occurs
    const rows = await (db as PrismaClient).$queryRaw<Array<{
      id: string;
      deliveryId: string;
      eventType: string;
      action: string | null;
      status: string;
      repositoryId: bigint | null;
      payload: unknown;
      payloadHash: string;
      errorMessage: string | null;
      processedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>>`
      INSERT INTO "GitHubWebhookDelivery" (
        "id",
        "deliveryId",
        "eventType",
        "action",
        "status",
        "repositoryId",
        "payload",
        "payloadHash",
        "errorMessage",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${id},
        ${input.deliveryId},
        ${input.eventType},
        ${input.action ?? null},
        ${status}::"GitHubDeliveryStatus",
        ${input.repositoryId ?? null},
        ${payloadJson}::jsonb,
        ${input.payloadHash},
        ${input.errorMessage ?? null},
        NOW(),
        NOW()
      )
      ON CONFLICT ("deliveryId") DO NOTHING
      RETURNING
        "id", "deliveryId", "eventType", "action", "status",
        "repositoryId", "payload", "payloadHash", "errorMessage",
        "processedAt", "createdAt", "updatedAt";
    `;

    if (rows.length > 0 && rows[0]) {
      const row = rows[0];
      return {
        created: true,
        delivery: {
          id: row.id,
          deliveryId: row.deliveryId,
          eventType: row.eventType,
          action: row.action,
          status: row.status as GitHubDeliveryStatus,
          repositoryId: row.repositoryId,
          payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
          payloadHash: row.payloadHash,
          errorMessage: row.errorMessage,
          processedAt: row.processedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      };
    }

    // Record already existed - retrieve it safely within the active transaction
    const existing = await this.findByDeliveryId(input.deliveryId, options);
    if (!existing) {
      throw new Error(`Failed to retrieve existing delivery '${input.deliveryId}' after conflict`);
    }

    return {
      created: false,
      delivery: existing,
    };
  }

  async findByDeliveryId(
    deliveryId: string,
    options?: WebhookDeliveryOptions
  ): Promise<GitHubWebhookDelivery | null> {
    const db = this.getClient(options);
    const row = await db.gitHubWebhookDelivery.findUnique({
      where: { deliveryId },
    });
    if (!row) return null;

    return {
      id: row.id,
      deliveryId: row.deliveryId,
      eventType: row.eventType,
      action: row.action,
      status: row.status as GitHubDeliveryStatus,
      repositoryId: row.repositoryId,
      payload: row.payload as Record<string, unknown>,
      payloadHash: row.payloadHash,
      errorMessage: row.errorMessage,
      processedAt: row.processedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async updateStatus(
    deliveryId: string,
    status: GitHubDeliveryStatus,
    errorMessage?: string | null,
    processedAt?: Date | null,
    options?: WebhookDeliveryOptions
  ): Promise<GitHubWebhookDelivery> {
    const db = this.getClient(options);
    const row = await db.gitHubWebhookDelivery.update({
      where: { deliveryId },
      data: {
        status,
        errorMessage,
        processedAt: processedAt !== undefined ? processedAt : status === "PROCESSED" ? new Date() : undefined,
      },
    });

    return {
      id: row.id,
      deliveryId: row.deliveryId,
      eventType: row.eventType,
      action: row.action,
      status: row.status as GitHubDeliveryStatus,
      repositoryId: row.repositoryId,
      payload: row.payload as Record<string, unknown>,
      payloadHash: row.payloadHash,
      errorMessage: row.errorMessage,
      processedAt: row.processedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
