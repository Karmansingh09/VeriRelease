import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TransactionalAuditService,
  computeAuditHash,
} from "../../src/modules/audit/audit-service";
import type { AuditRepository } from "../../src/modules/audit/audit-repository.interface";
import type { AuditLog, AuditEntityType } from "../../src/modules/audit/types";
import {
  DomainValidationError,
  DomainNotFoundError,
} from "../../src/modules/common/errors";
import type { DbClient, PrismaClient } from "../../src/lib/prisma";

describe("TransactionalAuditService Unit Tests", () => {
  let mockAuditRepo: AuditRepository;
  let mockPrismaClient: any;
  let auditService: TransactionalAuditService;

  beforeEach(() => {
    mockAuditRepo = {
      createAuditLog: vi.fn().mockImplementation(async (input) => {
        const log: AuditLog = {
          id: input.id ?? "aud_mock_id",
          entityType: input.entityType,
          entityId: input.entityId,
          actorType: input.actorType,
          actorUserId: input.actorUserId ?? null,
          actorSystemPrincipal: input.actorSystemPrincipal ?? null,
          action: input.action,
          previousState: input.previousState ?? null,
          newState: input.newState ?? null,
          metadata: input.metadata ?? null,
          correlationId: input.correlationId,
          timestamp: input.timestamp ?? new Date(),
        };
        return log;
      }),
      findById: vi.fn(),
      findByEntity: vi.fn(),
      findByCorrelationId: vi.fn(),
    };

    mockPrismaClient = {
      user: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          if (where.id === "usr_valid_123") {
            return { id: "usr_valid_123", email: "user@example.com" };
          }
          return null;
        }),
      },
    };

    auditService = new TransactionalAuditService(
      mockAuditRepo,
      mockPrismaClient as unknown as DbClient
    );
  });

  // 1. Valid user actor
  it("Requirement 1: Valid user actor is recorded with actorType 'USER' and verified actorUserId", async () => {
    const result = await auditService.recordEvent({
      entityType: "CONTRACT",
      entityId: "cnt_001",
      actorType: "USER",
      actorUserId: "usr_valid_123",
      action: "CONTRACT_CREATED",
      metadata: { note: "first contract" },
    });

    expect(result.auditLog).toBeDefined();
    expect(result.auditLog.actorType).toBe("USER");
    expect(result.auditLog.actorUserId).toBe("usr_valid_123");
    expect(result.auditLog.actorSystemPrincipal).toBeNull();
    expect(result.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mockAuditRepo.createAuditLog).toHaveBeenCalledTimes(1);
  });

  // 2. Valid system actor
  it("Requirement 2: Valid system actor is recorded with actorType 'SYSTEM_PRINCIPAL' and non-null actorSystemPrincipal", async () => {
    const resultSystem = await auditService.recordEvent({
      entityType: "MILESTONE",
      entityId: "ms_001",
      actorType: "SYSTEM",
      actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
      action: "EVALUATION_STARTED",
    });

    expect(resultSystem.auditLog.actorType).toBe("SYSTEM_PRINCIPAL");
    expect(resultSystem.auditLog.actorUserId).toBeNull();
    expect(resultSystem.auditLog.actorSystemPrincipal).toBe("SYSTEM_POLICY_ENGINE");
    expect(resultSystem.eventHash).toMatch(/^[0-9a-f]{64}$/);

    const resultPrincipal = await auditService.recordEvent({
      entityType: "MILESTONE",
      entityId: "ms_001",
      actorType: "SYSTEM_PRINCIPAL",
      action: "POLICY_EVALUATION_APPROVED",
    });

    expect(resultPrincipal.auditLog.actorType).toBe("SYSTEM_PRINCIPAL");
    expect(resultPrincipal.auditLog.actorUserId).toBeNull();
    expect(resultPrincipal.auditLog.actorSystemPrincipal).toBe("SYSTEM");
  });

  // 3. Both actor identities rejected
  it("Requirement 3: Providing both user and system actor identities is strictly rejected", async () => {
    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "USER",
        actorUserId: "usr_valid_123",
        actorSystemPrincipal: "SYSTEM_WORKER",
        action: "CONTRACT_UPDATED",
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        actorUserId: "usr_valid_123",
        actorSystemPrincipal: "SYSTEM_WORKER",
        action: "EVALUATION_STARTED",
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 4. Missing actor rejected
  it("Requirement 4: Missing actor or missing actor identifier is rejected", async () => {
    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "" as any,
        action: "CONTRACT_CREATED",
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "USER",
        actorUserId: undefined,
        action: "CONTRACT_CREATED",
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "USER",
        actorUserId: "   ",
        action: "CONTRACT_CREATED",
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 5. Invalid actor rejected
  it("Requirement 5: Invalid actor types are rejected", async () => {
    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "UNAUTHORIZED_BOT" as any,
        action: "CONTRACT_CREATED",
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "ADMIN" as any,
        action: "CONTRACT_CREATED",
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 6. Invalid user reference rejected
  it("Requirement 6: User actor with non-existent user ID is rejected with DomainNotFoundError", async () => {
    await expect(
      auditService.recordEvent({
        entityType: "CONTRACT",
        entityId: "cnt_001",
        actorType: "USER",
        actorUserId: "usr_does_not_exist",
        action: "CONTRACT_CREATED",
      })
    ).rejects.toThrow(DomainNotFoundError);
  });

  // 7. Valid canonical metadata accepted
  it("Requirement 7: Valid canonical metadata containing nested objects, arrays, numbers, strings, and booleans is accepted", async () => {
    const validMetadata = {
      nested: {
        score: 95,
        passed: true,
        summary: "All automated tests passed",
        details: [1, 2, "three", null],
      },
      count: 42,
      emptyObj: {},
    };

    const result = await auditService.recordEvent({
      entityType: "POLICY_EVALUATION",
      entityId: "pol_001",
      actorType: "SYSTEM",
      actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
      action: "POLICY_EVALUATION_APPROVED",
      metadata: validMetadata,
    });

    expect(result.auditLog).toBeDefined();
    expect(result.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.auditLog.metadata).toMatchObject(validMetadata);
  });

  // 8. Nested unsupported metadata rejected
  it("Requirement 8: Nested unsupported non-JSON metadata types are strictly rejected", async () => {
    // NaN
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: NaN },
      })
    ).rejects.toThrow(DomainValidationError);

    // Infinity
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: Infinity },
      })
    ).rejects.toThrow(DomainValidationError);

    // undefined
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: undefined },
      })
    ).rejects.toThrow(DomainValidationError);

    // BigInt
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: 100n as any },
      })
    ).rejects.toThrow(DomainValidationError);

    // Function
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: () => {} },
      })
    ).rejects.toThrow(DomainValidationError);

    // Symbol
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: Symbol("test") as any },
      })
    ).rejects.toThrow(DomainValidationError);

    // Date
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: new Date() as any },
      })
    ).rejects.toThrow(DomainValidationError);

    // Circular reference
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: circular,
      })
    ).rejects.toThrow(DomainValidationError);

    // Lone surrogate in string
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "TEST",
        metadata: { bad: "Invalid Unicode \uD800" },
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 9. Deterministic audit hash
  it("Requirement 9: Identical canonical event inputs produce identical SHA-256 hashes regardless of key insertion order", () => {
    const fixedTimestamp = new Date("2026-11-10T12:00:00.000Z");

    const event1 = {
      id: "aud_det_1",
      entityType: "MILESTONE" as AuditEntityType,
      entityId: "ms_001",
      actorType: "SYSTEM_PRINCIPAL" as const,
      actorUserId: null,
      actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
      action: "EVALUATION_STARTED",
      previousState: { status: "SUBMITTED" },
      newState: { status: "EVALUATING" },
      metadata: { alpha: 1, beta: "two", gamma: [3, 4] },
      correlationId: "corr_001",
      timestamp: fixedTimestamp,
    };

    // event2 has inverted key orders in metadata and states
    const event2 = {
      timestamp: fixedTimestamp,
      correlationId: "corr_001",
      metadata: { gamma: [3, 4], beta: "two", alpha: 1 },
      newState: { status: "EVALUATING" },
      previousState: { status: "SUBMITTED" },
      action: "EVALUATION_STARTED",
      actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
      actorUserId: null,
      actorType: "SYSTEM_PRINCIPAL" as const,
      entityId: "ms_001",
      entityType: "MILESTONE" as AuditEntityType,
      id: "aud_det_1",
    };

    const hash1 = computeAuditHash(event1);
    const hash2 = computeAuditHash(event2);

    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash2).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);

    // computeEventHash on the service also matches
    const serviceHash1 = auditService.computeEventHash({
      ...event1,
      actorType: "SYSTEM",
    });
    const serviceHash2 = auditService.computeEventHash({
      ...event2,
      actorType: "SYSTEM",
    });
    expect(serviceHash1).toBe(serviceHash2);
  });

  // 10. Caller-supplied hash cannot override the authoritative hash
  it("Requirement 10: Caller-supplied hash cannot override authoritative hash; mismatch is rejected", async () => {
    const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";

    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "EVALUATION_STARTED",
        hash: wrongHash,
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "EVALUATION_STARTED",
        eventHash: wrongHash,
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "EVALUATION_STARTED",
        metadata: { eventHash: wrongHash },
      })
    ).rejects.toThrow(DomainValidationError);

    // Correct matching hash succeeds and authoritative hash is persisted
    const validEventData = {
      id: "aud_exact_match",
      entityType: "MILESTONE" as AuditEntityType,
      entityId: "ms_001",
      actorType: "SYSTEM" as const,
      actorSystemPrincipal: "SYSTEM",
      action: "EVALUATION_STARTED",
      correlationId: "corr_match",
      timestamp: new Date("2026-11-10T12:00:00.000Z"),
    };

    const expectedHash = auditService.computeEventHash(validEventData);

    const successResult = await auditService.recordEvent({
      ...validEventData,
      hash: expectedHash,
    });

    expect(successResult.eventHash).toBe(expectedHash);
  });

  // 11. Caller-supplied auditHash is rejected
  it("Requirement 11: Caller-supplied auditHash is strictly rejected as a reserved key", async () => {
    // Top-level auditHash
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "EVALUATION_STARTED",
        auditHash: "unbound_hash_123",
      })
    ).rejects.toThrow(DomainValidationError);

    // In-metadata auditHash
    await expect(
      auditService.recordEvent({
        entityType: "MILESTONE",
        entityId: "ms_001",
        actorType: "SYSTEM",
        action: "EVALUATION_STARTED",
        metadata: { auditHash: "unbound_hash_456" },
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 12. Persisted eventHash can be independently recomputed from the persisted record
  it("Requirement 12: Persisted eventHash can still be independently recomputed from the persisted audit record", async () => {
    const eventInput = {
      id: "aud_recompute_test",
      entityType: "MILESTONE" as AuditEntityType,
      entityId: "ms_recompute_01",
      actorType: "SYSTEM" as const,
      actorSystemPrincipal: "SYSTEM_POLICY_ENGINE",
      action: "POLICY_EVALUATION_APPROVED",
      previousState: { status: "EVALUATING" },
      newState: { status: "ELIGIBLE_FOR_PAYOUT" },
      metadata: { submissionId: "sub_100", score: 100 },
      correlationId: "corr_recompute_01",
      timestamp: new Date("2026-11-10T12:00:00.000Z"),
    };

    const { auditLog, eventHash } = await auditService.recordEvent(eventInput);

    expect(auditLog.metadata).toHaveProperty("eventHash", eventHash);

    // Recompute directly from the persisted record (which has metadata.eventHash)
    const recomputed = computeAuditHash(auditLog);
    expect(recomputed).toBe(eventHash);
    expect(recomputed).toBe(auditLog.metadata!.eventHash);
  });
});
