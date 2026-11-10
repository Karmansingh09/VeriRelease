import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { WebhookDeliveryService } from "../../src/modules/github/webhook/webhook-delivery-service";
import type { WebhookDeliveryRepository } from "../../src/modules/github/webhook/webhook-delivery.interface";
import type { AuditService } from "../../src/modules/audit/audit-service.interface";
import type { GitHubWebhookDelivery } from "../../src/modules/github/types";
import {
  ConcurrencyConflictError,
  DomainValidationError,
  WebhookSignatureVerificationError,
} from "../../src/modules/common/errors";

describe("WebhookDeliveryService Unit Test Suite", () => {
  const secret = "test_webhook_secret_key_12345678";
  let mockDeliveryRepo: WebhookDeliveryRepository;
  let mockAuditService: AuditService;
  let service: WebhookDeliveryService;

  function sign(body: string, key: string = secret): string {
    return `sha256=${createHmac("sha256", key).update(Buffer.from(body, "utf8")).digest("hex")}`;
  }

  const validPayload = JSON.stringify({
    action: "opened",
    number: 10,
    repository: { id: 12345678, name: "repo" },
  });

  beforeEach(() => {
    mockDeliveryRepo = {
      create: vi.fn(),
      createIfNotExists: vi.fn(),
      findByDeliveryId: vi.fn(),
      updateStatus: vi.fn(),
    };

    mockAuditService = {
      recordEvent: vi.fn().mockResolvedValue({ auditLog: { id: "aud_1" }, eventHash: "hash_1" }),
      computeEventHash: vi.fn().mockReturnValue("hash_1"),
      getEventsForEntity: vi.fn().mockResolvedValue([]),
      getEventsByCorrelationId: vi.fn().mockResolvedValue([]),
    };

    const mockPrisma = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockPrisma)),
    };

    service = new WebhookDeliveryService(mockDeliveryRepo, mockAuditService, mockPrisma as any);
  });

  it("successfully ingests a valid webhook delivery, persists record, and audits event", async () => {
    const deliveryId = "del_valid_001";
    const signature = sign(validPayload);

    const createdDelivery: GitHubWebhookDelivery = {
      id: "del_row_001",
      deliveryId,
      eventType: "pull_request",
      action: "opened",
      status: "RECEIVED",
      repositoryId: 12345678n,
      payload: JSON.parse(validPayload),
      payloadHash: "mock_hash",
      errorMessage: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(mockDeliveryRepo.createIfNotExists).mockResolvedValue({
      created: true,
      delivery: createdDelivery,
    });

    const result = await service.ingestWebhook({
      rawBody: validPayload,
      signatureHeader: signature,
      deliveryId,
      eventType: "pull_request",
      webhookSecret: secret,
    });

    expect(result.outcome).toBe("accepted");
    expect(result.delivery.deliveryId).toBe(deliveryId);
    expect(mockDeliveryRepo.createIfNotExists).toHaveBeenCalledTimes(1);
    expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBHOOK_DELIVERY_ACCEPTED",
        entityType: "GITHUB_DELIVERY",
        entityId: deliveryId,
      }),
      expect.anything()
    );
  });

  it("idempotent duplicate delivery: returns existing delivery without re-creating", async () => {
    const deliveryId = "del_dup_001";
    const signature = sign(validPayload);
    const crypto = await import("node:crypto");
    const realPayloadHash = crypto.createHash("sha256").update(Buffer.from(validPayload, "utf8")).digest("hex");

    const existingDelivery: GitHubWebhookDelivery = {
      id: "del_row_dup",
      deliveryId,
      eventType: "pull_request",
      action: "opened",
      status: "RECEIVED",
      repositoryId: 12345678n,
      payload: JSON.parse(validPayload),
      payloadHash: realPayloadHash,
      errorMessage: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(mockDeliveryRepo.createIfNotExists).mockResolvedValue({
      created: false,
      delivery: existingDelivery,
    });

    const result = await service.ingestWebhook({
      rawBody: validPayload,
      signatureHeader: signature,
      deliveryId,
      eventType: "pull_request",
      webhookSecret: secret,
    });

    expect(result.outcome).toBe("duplicate");
    expect(result.delivery.deliveryId).toBe(deliveryId);
    expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DUPLICATE_DELIVERY_DETECTED",
        entityId: deliveryId,
      }),
      expect.anything()
    );
  });

  it("concurrent duplicate delivery collision: returns duplicate safely when createIfNotExists returns created=false", async () => {
    const deliveryId = "del_concurrent_001";
    const signature = sign(validPayload);
    const crypto = await import("node:crypto");
    const realPayloadHash = crypto.createHash("sha256").update(Buffer.from(validPayload, "utf8")).digest("hex");

    const concurrentDelivery: GitHubWebhookDelivery = {
      id: "del_row_concurrent",
      deliveryId,
      eventType: "pull_request",
      action: "opened",
      status: "RECEIVED",
      repositoryId: 12345678n,
      payload: JSON.parse(validPayload),
      payloadHash: realPayloadHash,
      errorMessage: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(mockDeliveryRepo.createIfNotExists).mockResolvedValue({
      created: false,
      delivery: concurrentDelivery,
    });

    const result = await service.ingestWebhook({
      rawBody: validPayload,
      signatureHeader: signature,
      deliveryId,
      eventType: "pull_request",
      webhookSecret: secret,
    });

    expect(result.outcome).toBe("duplicate");
    expect(result.delivery.deliveryId).toBe(deliveryId);
  });

  it("tampering attack detection: throws ConcurrencyConflictError if existing delivery has different payload hash", async () => {
    const deliveryId = "del_tamper_001";
    const signature = sign(validPayload);

    const existingWithDifferentHash: GitHubWebhookDelivery = {
      id: "del_row_tamper",
      deliveryId,
      eventType: "pull_request",
      action: "opened",
      status: "RECEIVED",
      repositoryId: 12345678n,
      payload: { original: true },
      payloadHash: "different_hash_value_1234567890abcdef1234567890abcdef1234567890abcdef",
      errorMessage: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(mockDeliveryRepo.createIfNotExists).mockResolvedValue({
      created: false,
      delivery: existingWithDifferentHash,
    });

    await expect(
      service.ingestWebhook({
        rawBody: validPayload,
        signatureHeader: signature,
        deliveryId,
        eventType: "pull_request",
        webhookSecret: secret,
      })
    ).rejects.toThrow(ConcurrencyConflictError);

    expect(mockDeliveryRepo.create).not.toHaveBeenCalled();
  });

  it("audit amplification prevention: rejects invalid signature without writing to database AuditLog table", async () => {
    const deliveryId = "del_bad_sig";
    const invalidSignature = "sha256=" + "f".repeat(64);

    await expect(
      service.ingestWebhook({
        rawBody: validPayload,
        signatureHeader: invalidSignature,
        deliveryId,
        eventType: "pull_request",
        webhookSecret: secret,
      })
    ).rejects.toThrow(WebhookSignatureVerificationError);

    // Verified: No database AuditLog insert on unauthenticated invalid requests
    expect(mockAuditService.recordEvent).not.toHaveBeenCalled();
  });

  it("rejects missing delivery ID with DomainValidationError", async () => {
    await expect(
      service.ingestWebhook({
        rawBody: validPayload,
        signatureHeader: sign(validPayload),
        deliveryId: "   ",
        eventType: "pull_request",
        webhookSecret: secret,
      })
    ).rejects.toThrow(DomainValidationError);
  });

  it("rejects missing event type with DomainValidationError", async () => {
    await expect(
      service.ingestWebhook({
        rawBody: validPayload,
        signatureHeader: sign(validPayload),
        deliveryId: "del_123",
        eventType: "",
        webhookSecret: secret,
      })
    ).rejects.toThrow(DomainValidationError);
  });

  it("rejects malformed non-JSON payload with DomainValidationError", async () => {
    const nonJson = "NOT_A_VALID_JSON_STRING";
    await expect(
      service.ingestWebhook({
        rawBody: nonJson,
        signatureHeader: sign(nonJson),
        deliveryId: "del_123",
        eventType: "pull_request",
        webhookSecret: secret,
      })
    ).rejects.toThrow(DomainValidationError);
  });
});
