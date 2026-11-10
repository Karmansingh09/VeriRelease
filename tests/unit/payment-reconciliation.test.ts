import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentReconciliationServiceImpl } from "../../src/modules/payments/reconciliation-service";
import type { PaymentRepository } from "../../src/modules/payments/payment-repository.interface";
import type { ReconciliationRepository } from "../../src/modules/payments/reconciliation-repository.interface";
import type { AuditService } from "../../src/modules/audit/audit-service.interface";
import type {
  PaymentTransaction,
  PaymentReconciliation,
} from "../../src/modules/payments/types";
import {
  DomainValidationError,
  ConcurrencyConflictError,
  DuplicatePayoutError,
} from "../../src/modules/common/errors";

describe("PaymentReconciliationService Unit Tests", () => {
  let mockPaymentRepo: PaymentRepository;
  let mockReconciliationRepo: ReconciliationRepository;
  let mockAuditService: AuditService;
  let mockPrismaClient: any;
  let reconciliationService: PaymentReconciliationServiceImpl;

  const sampleUncertainTx: PaymentTransaction = {
    id: "tx_uncert_001",
    milestoneId: "mls_001",
    submissionId: "sub_001",
    transactionType: "PAYOUT",
    status: "PAYOUT_UNCERTAIN",
    idempotencyKey: "c".repeat(64),
    amountMinorUnits: 400000n,
    currency: "USD",
    attemptNumber: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const sampleReconciliationRecord: PaymentReconciliation = {
    id: "rec_mock_001",
    paymentTransactionId: "tx_uncert_001",
    decision: "CONFIRMED_SUCCEEDED",
    reason: "Resolved via PayPal support ticket",
    evidenceReference: "PP-SUPPORT-9988",
    evidenceType: "PAYPAL_SUPPORT_TICKET",
    actorType: "USER",
    actorUserId: "usr_client_001",
    actorSystemPrincipal: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    mockPaymentRepo = {
      createTransaction: vi.fn(),
      updateStatus: vi.fn().mockImplementation(async (id, milestoneId, fromStatus, toStatus) => ({
        ...sampleUncertainTx,
        status: toStatus,
      })),
      findById: vi.fn(),
      findByIdempotencyKey: vi.fn(),
      findActiveByMilestoneId: vi.fn(),
      findSucceededPayoutByMilestoneId: vi.fn(),
      findByMilestoneId: vi.fn(),
      findStaleReserved: vi.fn(),
      findStaleProcessing: vi.fn(),
      getNextAttemptNumber: vi.fn(),
    };

    mockReconciliationRepo = {
      createReconciliation: vi.fn().mockResolvedValue(sampleReconciliationRecord),
      findById: vi.fn().mockResolvedValue(sampleReconciliationRecord),
      findByPaymentTransactionId: vi.fn().mockResolvedValue([sampleReconciliationRecord]),
    };

    mockAuditService = {
      recordEvent: vi.fn().mockResolvedValue({
        auditLog: {} as any,
        eventHash: "d".repeat(64),
      }),
      computeEventHash: vi.fn().mockReturnValue("d".repeat(64)),
      getEventsForEntity: vi.fn().mockResolvedValue([]),
      getEventsByCorrelationId: vi.fn().mockResolvedValue([]),
    };

    // Mock Prisma Client transaction and raw queries
    mockPrismaClient = {
      $transaction: vi.fn().mockImplementation(async (cb) => cb(mockPrismaClient)),
      $queryRaw: vi.fn().mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join(" ") : String(query);
        if (text.includes("FROM \"Milestone\"")) {
          return [{ id: "mls_001", status: "SUBMITTED" }];
        }
        if (text.includes("FROM \"PaymentTransaction\"") && text.includes("LIMIT 1")) {
          // Duplicate payout check query
          return [];
        }
        if (text.includes("FROM \"PaymentTransaction\"")) {
          return [
            {
              id: "tx_uncert_001",
              milestoneId: "mls_001",
              transactionType: "PAYOUT",
              status: "PAYOUT_UNCERTAIN",
              idempotencyKey: "c".repeat(64),
              attemptNumber: 1,
            },
          ];
        }
        return [];
      }),
    };

    reconciliationService = new PaymentReconciliationServiceImpl(
      mockPaymentRepo,
      mockReconciliationRepo,
      mockAuditService,
      mockPrismaClient
    );
  });

  describe("Input Validation", () => {
    it("rejects empty or whitespace reason with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "CONFIRMED_SUCCEEDED",
          reason: "   ",
          evidenceReference: "ref-123",
          actor: { actorType: "USER", actorUserId: "usr_client_001" },
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects missing evidenceReference for CONFIRMED_SUCCEEDED with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "CONFIRMED_SUCCEEDED",
          reason: "Confirmed payment",
          evidenceReference: "",
          actor: { actorType: "USER", actorUserId: "usr_client_001" },
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects missing evidenceReference for CONFIRMED_FAILED with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "CONFIRMED_FAILED",
          reason: "Bank confirmed chargeback",
          evidenceReference: undefined,
          actor: { actorType: "USER", actorUserId: "usr_client_001" },
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("permits missing evidenceReference for STILL_UNCERTAIN", async () => {
      const result = await reconciliationService.reconcilePayment({
        transactionId: "tx_uncert_001",
        milestoneId: "mls_001",
        decision: "STILL_UNCERTAIN",
        reason: "Provider ticket still in progress",
        actor: { actorType: "USER", actorUserId: "usr_client_001" },
      });

      expect(result.transaction.status).toBe("RECONCILIATION_REQUIRED");
      expect(mockReconciliationRepo.createReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "STILL_UNCERTAIN",
          reason: "Provider ticket still in progress",
          evidenceReference: null,
        }),
        expect.anything()
      );
    });

    it("rejects USER actor without actorUserId with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "STILL_UNCERTAIN",
          reason: "Waiting",
          actor: { actorType: "USER", actorUserId: "  " },
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects USER actor with actorSystemPrincipal with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "STILL_UNCERTAIN",
          reason: "Waiting",
          actor: {
            actorType: "USER",
            actorUserId: "usr_001",
            actorSystemPrincipal: "principal_001",
          },
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects non-USER actor with actorUserId with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "STILL_UNCERTAIN",
          reason: "Waiting",
          actor: {
            actorType: "SYSTEM_PRINCIPAL",
            actorUserId: "usr_001",
            actorSystemPrincipal: "worker_recon",
          },
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects non-USER actor without actorSystemPrincipal with DomainValidationError", async () => {
      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "STILL_UNCERTAIN",
          reason: "Waiting",
          actor: {
            actorType: "SYSTEM_PRINCIPAL",
            actorSystemPrincipal: "  ",
          },
        })
      ).rejects.toThrow(DomainValidationError);
    });
  });

  describe("Outcome 1: CONFIRMED_SUCCEEDED", () => {
    it("transitions PAYOUT_UNCERTAIN -> SUCCEEDED, acquires milestone lock, and creates reconciliation + audit records", async () => {
      const result = await reconciliationService.reconcilePayment({
        transactionId: "tx_uncert_001",
        milestoneId: "mls_001",
        decision: "CONFIRMED_SUCCEEDED",
        reason: "PayPal confirmed item status COMPLETED",
        evidenceReference: "PP-TX-BATCH-001",
        evidenceType: "PAYPAL_API_EXPORT",
        actor: { actorType: "USER", actorUserId: "usr_client_001" },
      });

      expect(result.transaction.status).toBe("SUCCEEDED");
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        "tx_uncert_001",
        "mls_001",
        "PAYOUT_UNCERTAIN",
        "SUCCEEDED",
        expect.anything(),
        expect.anything()
      );

      // Verify reconciliation created
      expect(mockReconciliationRepo.createReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentTransactionId: "tx_uncert_001",
          decision: "CONFIRMED_SUCCEEDED",
          reason: "PayPal confirmed item status COMPLETED",
          evidenceReference: "PP-TX-BATCH-001",
          evidenceType: "PAYPAL_API_EXPORT",
          actorType: "USER",
          actorUserId: "usr_client_001",
        }),
        expect.anything()
      );

      // Verify audit recorded with SUPPLIED_NOT_VERIFIED
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "PAYMENT",
          entityId: "tx_uncert_001",
          action: "PAYOUT_RECONCILED_SUCCEEDED",
          previousState: { status: "PAYOUT_UNCERTAIN" },
          newState: { status: "SUCCEEDED" },
          metadata: expect.objectContaining({
            decision: "CONFIRMED_SUCCEEDED",
            evidenceReference: "PP-TX-BATCH-001",
            evidenceVerificationStatus: "SUPPLIED_NOT_VERIFIED",
          }),
        }),
        expect.anything()
      );
    });

    it("transitions RECONCILIATION_REQUIRED -> SUCCEEDED", async () => {
      mockPrismaClient.$queryRaw.mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join(" ") : String(query);
        if (text.includes("FROM \"Milestone\"")) {
          return [{ id: "mls_001", status: "SUBMITTED" }];
        }
        if (text.includes("FROM \"PaymentTransaction\"") && text.includes("LIMIT 1")) {
          return [];
        }
        if (text.includes("FROM \"PaymentTransaction\"")) {
          return [
            {
              id: "tx_uncert_001",
              milestoneId: "mls_001",
              transactionType: "PAYOUT",
              status: "RECONCILIATION_REQUIRED",
              idempotencyKey: "c".repeat(64),
              attemptNumber: 1,
            },
          ];
        }
        return [];
      });

      const result = await reconciliationService.reconcilePayment({
        transactionId: "tx_uncert_001",
        milestoneId: "mls_001",
        decision: "CONFIRMED_SUCCEEDED",
        reason: "Authoritative settlement export confirmed",
        evidenceReference: "SETTLE-001",
        actor: {
          actorType: "SYSTEM_PRINCIPAL",
          actorSystemPrincipal: "RECONCILIATION_WORKER",
        },
      });

      expect(result.transaction.status).toBe("SUCCEEDED");
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        "tx_uncert_001",
        "mls_001",
        "RECONCILIATION_REQUIRED",
        "SUCCEEDED",
        expect.anything(),
        expect.anything()
      );
    });

    it("throws DuplicatePayoutError when another succeeded payout exists for milestone", async () => {
      mockPrismaClient.$queryRaw.mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join(" ") : String(query);
        if (text.includes("FROM \"Milestone\"")) {
          return [{ id: "mls_001", status: "SUBMITTED" }];
        }
        if (text.includes("FROM \"PaymentTransaction\"") && text.includes("LIMIT 1")) {
          return [{ id: "tx_other_succeeded" }];
        }
        return [];
      });

      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "CONFIRMED_SUCCEEDED",
          reason: "Attempting duplicate success",
          evidenceReference: "PP-DUP",
          actor: { actorType: "USER", actorUserId: "usr_client_001" },
        })
      ).rejects.toThrow(DuplicatePayoutError);
    });
  });

  describe("Outcome 2: CONFIRMED_FAILED", () => {
    it("transitions PAYOUT_UNCERTAIN -> FAILED with authoritative failure evidence", async () => {
      const result = await reconciliationService.reconcilePayment({
        transactionId: "tx_uncert_001",
        milestoneId: "mls_001",
        decision: "CONFIRMED_FAILED",
        reason: "PayPal batch item denied by receiver country restriction",
        evidenceReference: "PP-ERROR-RECEIVER-DENIED",
        evidenceType: "PAYPAL_API_ERROR_RECEIPT",
        actor: {
          actorType: "SYSTEM_PRINCIPAL",
          actorSystemPrincipal: "WORKER_RECON",
        },
      });

      expect(result.transaction.status).toBe("FAILED");
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        "tx_uncert_001",
        "mls_001",
        "PAYOUT_UNCERTAIN",
        "FAILED",
        expect.objectContaining({
          errorMessage: "PayPal batch item denied by receiver country restriction",
        }),
        expect.anything()
      );

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_RECONCILED_FAILED",
          previousState: { status: "PAYOUT_UNCERTAIN" },
          newState: { status: "FAILED" },
        }),
        expect.anything()
      );
    });

    it("transitions RECONCILIATION_REQUIRED -> FAILED", async () => {
      mockPrismaClient.$queryRaw.mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join(" ") : String(query);
        if (text.includes("FROM \"PaymentTransaction\"")) {
          return [
            {
              id: "tx_uncert_001",
              milestoneId: "mls_001",
              transactionType: "PAYOUT",
              status: "RECONCILIATION_REQUIRED",
              idempotencyKey: "c".repeat(64),
              attemptNumber: 1,
            },
          ];
        }
        return [];
      });

      const result = await reconciliationService.reconcilePayment({
        transactionId: "tx_uncert_001",
        milestoneId: "mls_001",
        decision: "CONFIRMED_FAILED",
        reason: "Provider account closed permanently",
        evidenceReference: "SUPPORT-TICKET-CLOSE",
        actor: { actorType: "USER", actorUserId: "usr_client_001" },
      });

      expect(result.transaction.status).toBe("FAILED");
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        "tx_uncert_001",
        "mls_001",
        "RECONCILIATION_REQUIRED",
        "FAILED",
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe("Outcome 3: STILL_UNCERTAIN", () => {
    it("transitions PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED to keep active payment guard in place", async () => {
      const result = await reconciliationService.reconcilePayment({
        transactionId: "tx_uncert_001",
        milestoneId: "mls_001",
        decision: "STILL_UNCERTAIN",
        reason: "PayPal investigation pending, ticket #12345 open",
        actor: {
          actorType: "SYSTEM_PRINCIPAL",
          actorSystemPrincipal: "RECONCILIATION_CRON",
        },
      });

      expect(result.transaction.status).toBe("RECONCILIATION_REQUIRED");
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        "tx_uncert_001",
        "mls_001",
        "PAYOUT_UNCERTAIN",
        "RECONCILIATION_REQUIRED",
        expect.anything(),
        expect.anything()
      );

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PAYOUT_RECONCILIATION_STILL_UNCERTAIN",
          previousState: { status: "PAYOUT_UNCERTAIN" },
          newState: { status: "RECONCILIATION_REQUIRED" },
        }),
        expect.anything()
      );
    });

    it("rejects STILL_UNCERTAIN if payment is already in RECONCILIATION_REQUIRED", async () => {
      mockPrismaClient.$queryRaw.mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join(" ") : String(query);
        if (text.includes("FROM \"PaymentTransaction\"")) {
          return [
            {
              id: "tx_uncert_001",
              milestoneId: "mls_001",
              transactionType: "PAYOUT",
              status: "RECONCILIATION_REQUIRED",
              idempotencyKey: "c".repeat(64),
              attemptNumber: 1,
            },
          ];
        }
        return [];
      });

      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "STILL_UNCERTAIN",
          reason: "Still waiting",
          actor: { actorType: "USER", actorUserId: "usr_client_001" },
        })
      ).rejects.toThrow(ConcurrencyConflictError);
    });
  });

  describe("Invalid State Guard", () => {
    it("rejects reconciliation on RESERVED payment", async () => {
      mockPrismaClient.$queryRaw.mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join(" ") : String(query);
        if (text.includes("FROM \"Milestone\"")) {
          return [{ id: "mls_001", status: "SUBMITTED" }];
        }
        if (text.includes("FROM \"PaymentTransaction\"") && text.includes("LIMIT 1")) {
          return [];
        }
        if (text.includes("FROM \"PaymentTransaction\"")) {
          return [
            {
              id: "tx_uncert_001",
              milestoneId: "mls_001",
              transactionType: "PAYOUT",
              status: "RESERVED",
              idempotencyKey: "c".repeat(64),
              attemptNumber: 1,
            },
          ];
        }
        return [];
      });

      await expect(
        reconciliationService.reconcilePayment({
          transactionId: "tx_uncert_001",
          milestoneId: "mls_001",
          decision: "CONFIRMED_SUCCEEDED",
          reason: "Trying to skip processing",
          evidenceReference: "REF-1",
          actor: { actorType: "USER", actorUserId: "usr_client_001" },
        })
      ).rejects.toThrow(ConcurrencyConflictError);
    });
  });
});
