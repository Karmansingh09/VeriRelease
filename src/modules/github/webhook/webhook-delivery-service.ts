/**
 * VeriRelease GitHub Webhook Ingestion Service
 *
 * Coordinates raw-body HMAC-SHA256 signature verification, durable delivery persistence,
 * idempotent duplicate delivery detection, and audit logging.
 */

import { createHash } from "node:crypto";
import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../../lib/prisma";
import {
  ConcurrencyConflictError,
  DomainValidationError,
} from "../../common/errors";
import { redactSecrets } from "../../common/redact";
import type { AuditService } from "../../audit/audit-service.interface";
import { TransactionalAuditService } from "../../audit/audit-service";
import type { GitHubWebhookDelivery } from "../types";
import { WebhookSignatureVerifier } from "./signature-verifier";
import type { WebhookDeliveryRepository } from "./webhook-delivery.interface";
import { PrismaWebhookDeliveryRepository } from "./prisma-webhook-delivery-repository";

export interface IngestWebhookInput {
  rawBody: Buffer | string;
  signatureHeader?: string | null;
  deliveryId?: string | null;
  eventType?: string | null;
  webhookSecret: string;
}

export type WebhookIngestionOutcome = "accepted" | "duplicate";

export interface WebhookIngestionResult {
  outcome: WebhookIngestionOutcome;
  delivery: GitHubWebhookDelivery;
}

export interface WebhookDeliveryServiceOptions {
  tx?: PrismaTransactionClient;
}

export class WebhookDeliveryService {
  constructor(
    private readonly deliveryRepo: WebhookDeliveryRepository = new PrismaWebhookDeliveryRepository(prisma),
    private readonly auditService: AuditService = new TransactionalAuditService(undefined, prisma),
    private readonly client: DbClient = prisma
  ) {}

  /**
   * Ingests an inbound GitHub webhook delivery.
   *
   * Security & Idempotency Pipeline:
   * 1. Validates delivery headers (x-github-delivery, x-github-event).
   * 2. Verifies HMAC-SHA256 signature over raw request bytes using constant-time comparison.
   * 3. Parses JSON payload safely.
   * 4. Computes SHA-256 payload digest.
   * 5. Performs durable deduplication:
   *    - Existing delivery + matching hash => idempotent retry, returns "duplicate".
   *    - Existing delivery + mismatched hash => replay/tampering attack, throws ConcurrencyConflictError.
   *    - Concurrent delivery collision (P2002) => safely catches unique violation, re-checks hash, returns "duplicate".
   *    - New delivery => persists record with status "RECEIVED", emits audit event, returns "accepted".
   * 6. Audit amplification protection: Invalid signatures do NOT insert rows into database AuditLog table.
   */
  async ingestWebhook(
    input: IngestWebhookInput,
    options?: WebhookDeliveryServiceOptions
  ): Promise<WebhookIngestionResult> {
    const deliveryId = input.deliveryId?.trim();
    if (!deliveryId || deliveryId.length === 0 || deliveryId.length > 64) {
      throw new DomainValidationError("Missing or invalid X-GitHub-Delivery header");
    }

    const eventType = input.eventType?.trim();
    if (!eventType || eventType.length === 0) {
      throw new DomainValidationError("Missing X-GitHub-Event header");
    }

    const rawBuffer = Buffer.isBuffer(input.rawBody)
      ? input.rawBody
      : Buffer.from(input.rawBody, "utf8");

    // 1. Signature Verification
    try {
      WebhookSignatureVerifier.verify({
        rawBody: rawBuffer,
        signatureHeader: input.signatureHeader,
        webhookSecret: input.webhookSecret,
      });
    } catch (err) {
      // Security logging: do NOT write to database AuditLog on unauthenticated invalid requests
      // to prevent database disk amplification / Denial of Service.
      console.warn(
        `[SECURITY] Webhook signature rejected for delivery '${redactSecrets(deliveryId)}': ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }

    // 2. Parse payload safely
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBuffer.toString("utf8")) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Payload must be a JSON object");
      }
    } catch (parseErr) {
      throw new DomainValidationError(
        `Malformed JSON payload: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }

    // 3. Compute SHA-256 hash of raw body
    const payloadHash = createHash("sha256").update(rawBuffer).digest("hex");

    // Extract action and repositoryId if present
    const action = typeof payload.action === "string" ? payload.action : null;
    let repositoryId: bigint | null = null;
    if (payload.repository && typeof payload.repository === "object") {
      const repoObj = payload.repository as Record<string, unknown>;
      if (typeof repoObj.id === "number") {
        repositoryId = BigInt(repoObj.id);
      }
    }

    const runInTx = async (tx: PrismaTransactionClient): Promise<WebhookIngestionResult> => {
      // 4. Conflict-safe atomic insertion (ON CONFLICT DO NOTHING RETURNING ...)
      // Prevents PostgreSQL unique-violation transaction abort under concurrent load
      const { created, delivery } = await this.deliveryRepo.createIfNotExists(
        {
          deliveryId,
          eventType,
          action,
          status: "RECEIVED",
          repositoryId,
          payload,
          payloadHash,
        },
        { tx }
      );

      if (created) {
        // Record audit event for accepted new delivery
        await this.auditService.recordEvent(
          {
            entityType: "GITHUB_DELIVERY",
            entityId: deliveryId,
            actorType: "WEBHOOK_GITHUB",
            actorSystemPrincipal: `github-webhook:${deliveryId}`,
            action: "WEBHOOK_DELIVERY_ACCEPTED",
            metadata: {
              deliveryId,
              eventType,
              action,
              repositoryId: repositoryId ? repositoryId.toString() : null,
            },
            correlationId: deliveryId,
          },
          { tx }
        );

        return { outcome: "accepted", delivery };
      }

      // 5. Existing delivery or concurrent insertion: idempotent hash verification
      if (delivery.payloadHash === payloadHash) {
        // Record idempotent duplicate audit event
        await this.auditService.recordEvent(
          {
            entityType: "GITHUB_DELIVERY",
            entityId: deliveryId,
            actorType: "WEBHOOK_GITHUB",
            actorSystemPrincipal: `github-webhook:${deliveryId}`,
            action: "DUPLICATE_DELIVERY_DETECTED",
            metadata: {
              deliveryId,
              eventType,
              status: delivery.status,
            },
            correlationId: deliveryId,
          },
          { tx }
        );

        return { outcome: "duplicate", delivery };
      }

      // Hash mismatch with identical delivery ID is a replay / tampering attack
      throw new ConcurrencyConflictError(
        `Delivery ID '${deliveryId}' already exists with conflicting payload hash`
      );
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  /**
   * Updates delivery status (e.g. when asynchronous worker claims or finishes processing).
   */
  async updateDeliveryStatus(
    deliveryId: string,
    status: "PROCESSING" | "PROCESSED" | "FAILED" | "IGNORED",
    errorMessage?: string | null,
    options?: WebhookDeliveryServiceOptions
  ): Promise<GitHubWebhookDelivery> {
    return this.deliveryRepo.updateStatus(deliveryId, status, errorMessage, undefined, options);
  }

  /**
   * Retrieves a delivery by its GitHub delivery ID.
   */
  async getDelivery(
    deliveryId: string,
    options?: WebhookDeliveryServiceOptions
  ): Promise<GitHubWebhookDelivery | null> {
    return this.deliveryRepo.findByDeliveryId(deliveryId, options);
  }
}
