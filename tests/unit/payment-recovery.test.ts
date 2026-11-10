import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaymentRecoveryServiceImpl,
  DEFAULT_STALE_RESERVED_SECONDS,
  DEFAULT_STALE_PROCESSING_SECONDS,
} from "../../src/modules/payments/recovery-service";
import type { PaymentRepository } from "../../src/modules/payments/payment-repository.interface";
import type { PaymentService } from "../../src/modules/payments/payment-service.interface";
import type { PaymentTransaction } from "../../src/modules/payments/types";
import { ConcurrencyConflictError } from "../../src/modules/common/errors";

describe("PaymentRecoveryService Unit Tests", () => {
  let mockPaymentRepo: PaymentRepository;
  let mockPaymentService: PaymentService;
  let recoveryService: PaymentRecoveryServiceImpl;

  const sampleReservedTx: PaymentTransaction = {
    id: "tx_res_001",
    milestoneId: "mls_001",
    submissionId: "sub_001",
    transactionType: "PAYOUT",
    status: "RESERVED",
    idempotencyKey: "a".repeat(64),
    amountMinorUnits: 500000n,
    currency: "USD",
    attemptNumber: 1,
    rawRequest: { recipient: "dev@example.com" },
    createdAt: new Date(Date.now() - 600 * 1000), // 10 minutes ago
    updatedAt: new Date(Date.now() - 600 * 1000),
  };

  const sampleProcessingTx: PaymentTransaction = {
    id: "tx_proc_001",
    milestoneId: "mls_001",
    submissionId: "sub_001",
    transactionType: "PAYOUT",
    status: "PROCESSING",
    idempotencyKey: "b".repeat(64),
    amountMinorUnits: 500000n,
    currency: "USD",
    attemptNumber: 2,
    rawRequest: { recipient: "dev@example.com" },
    createdAt: new Date(Date.now() - 300 * 1000),
    updatedAt: new Date(Date.now() - 300 * 1000), // 5 minutes ago
  };

  beforeEach(() => {
    mockPaymentRepo = {
      createTransaction: vi.fn(),
      updateStatus: vi.fn(),
      findById: vi.fn(),
      findByIdempotencyKey: vi.fn(),
      findActiveByMilestoneId: vi.fn(),
      findSucceededPayoutByMilestoneId: vi.fn(),
      findByMilestoneId: vi.fn(),
      findStaleReserved: vi.fn().mockResolvedValue([sampleReservedTx]),
      findStaleProcessing: vi.fn().mockResolvedValue([sampleProcessingTx]),
      getNextAttemptNumber: vi.fn(),
    };

    mockPaymentService = {
      reservePayout: vi.fn(),
      claimProcessing: vi.fn().mockResolvedValue({
        ...sampleReservedTx,
        status: "PROCESSING",
      }),
      transitionStatus: vi.fn().mockResolvedValue({
        ...sampleProcessingTx,
        status: "PAYOUT_UNCERTAIN",
      }),
      reconcilePayment: vi.fn(),
      recoverStaleReserved: vi.fn(),
      recoverStaleProcessing: vi.fn(),
      getTransaction: vi.fn(),
      getTransactionByIdempotencyKey: vi.fn(),
    };

    recoveryService = new PaymentRecoveryServiceImpl(
      mockPaymentRepo,
      mockPaymentService
    );
  });

  describe("recoverStaleReserved", () => {
    it("identifies stale RESERVED transactions and atomically claims them for processing", async () => {
      const report = await recoveryService.recoverStaleReserved({
        olderThanSeconds: 300,
      });

      expect(mockPaymentRepo.findStaleReserved).toHaveBeenCalledTimes(1);
      expect(mockPaymentService.claimProcessing).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: "tx_res_001",
          milestoneId: "mls_001",
          action: "PAYOUT_RESERVED_RECOVERED",
          metadata: expect.objectContaining({
            recoveryType: "STALE_RESERVED",
            olderThanSeconds: 300,
          }),
        }),
        undefined
      );

      expect(report.scannedCount).toBe(1);
      expect(report.claimedCount).toBe(1);
      expect(report.results).toHaveLength(1);

      const item = report.results[0]!;
      expect(item.claimed).toBe(true);
      expect(item.dispatchReady).toBe(true);
      expect(item.transactionId).toBe("tx_res_001");
      expect(item.idempotencyKey).toBe(sampleReservedTx.idempotencyKey);
      expect(item.attemptNumber).toBe(1);
      expect(item.amountMinorUnits).toBe(500000n);
      expect(item.currency).toBe("USD");
      expect(item.recipient).toBe("dev@example.com");
      expect(item.submissionId).toBe("sub_001");
      expect(item.milestoneId).toBe("mls_001");
    });

    it("uses default threshold of 300s (5 minutes) when olderThanSeconds is not provided", async () => {
      const fixedNow = new Date("2026-11-10T12:00:00Z");
      await recoveryService.recoverStaleReserved({ now: fixedNow });

      const expectedCutoff = new Date(fixedNow.getTime() - DEFAULT_STALE_RESERVED_SECONDS * 1000);
      expect(mockPaymentRepo.findStaleReserved).toHaveBeenCalledWith(
        expectedCutoff,
        50,
        undefined
      );
    });

    it("handles concurrent claim conflict gracefully without failing the recovery run", async () => {
      vi.mocked(mockPaymentService.claimProcessing).mockRejectedValueOnce(
        new ConcurrencyConflictError("Status already altered")
      );

      const report = await recoveryService.recoverStaleReserved();
      expect(report.scannedCount).toBe(1);
      expect(report.claimedCount).toBe(0);
      expect(report.results[0]!.claimed).toBe(false);
      expect(report.results[0]!.dispatchReady).toBe(false);
      expect(report.results[0]!.skippedReason).toContain("already claimed");
    });

    it("returns empty report when no stale RESERVED transactions are found", async () => {
      vi.mocked(mockPaymentRepo.findStaleReserved).mockResolvedValueOnce([]);

      const report = await recoveryService.recoverStaleReserved();
      expect(report.scannedCount).toBe(0);
      expect(report.claimedCount).toBe(0);
      expect(report.results).toEqual([]);
      expect(mockPaymentService.claimProcessing).not.toHaveBeenCalled();
    });
  });

  describe("recoverStaleProcessing", () => {
    it("identifies stale PROCESSING transactions and transitions them to PAYOUT_UNCERTAIN", async () => {
      const report = await recoveryService.recoverStaleProcessing({
        olderThanSeconds: 120,
      });

      expect(mockPaymentRepo.findStaleProcessing).toHaveBeenCalledTimes(1);
      expect(mockPaymentService.transitionStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: "tx_proc_001",
          milestoneId: "mls_001",
          fromStatus: "PROCESSING",
          toStatus: "PAYOUT_UNCERTAIN",
          action: "PAYOUT_PROCESSING_STALE_UNCERTAIN",
        }),
        undefined
      );

      expect(report.scannedCount).toBe(1);
      expect(report.transitionedCount).toBe(1);
      expect(report.results).toHaveLength(1);

      const item = report.results[0]!;
      expect(item.transitioned).toBe(true);
      expect(item.toStatus).toBe("PAYOUT_UNCERTAIN");
      expect(item.transactionId).toBe("tx_proc_001");
      expect(item.idempotencyKey).toBe(sampleProcessingTx.idempotencyKey);
      expect(item.attemptNumber).toBe(2);
    });

    it("uses default threshold of 120s (2 minutes) when olderThanSeconds is not provided", async () => {
      const fixedNow = new Date("2026-11-10T12:00:00Z");
      await recoveryService.recoverStaleProcessing({ now: fixedNow });

      const expectedCutoff = new Date(fixedNow.getTime() - DEFAULT_STALE_PROCESSING_SECONDS * 1000);
      expect(mockPaymentRepo.findStaleProcessing).toHaveBeenCalledWith(
        expectedCutoff,
        50,
        undefined
      );
    });

    it("handles concurrent state transition conflict gracefully", async () => {
      vi.mocked(mockPaymentService.transitionStatus).mockRejectedValueOnce(
        new ConcurrencyConflictError("Record locked by another worker")
      );

      const report = await recoveryService.recoverStaleProcessing();
      expect(report.scannedCount).toBe(1);
      expect(report.transitionedCount).toBe(0);
      expect(report.results[0]!.transitioned).toBe(false);
      expect(report.results[0]!.skippedReason).toContain("altered or locked concurrently");
    });

    it("returns empty report when no stale PROCESSING transactions are found", async () => {
      vi.mocked(mockPaymentRepo.findStaleProcessing).mockResolvedValueOnce([]);

      const report = await recoveryService.recoverStaleProcessing();
      expect(report.scannedCount).toBe(0);
      expect(report.transitionedCount).toBe(0);
      expect(report.results).toEqual([]);
      expect(mockPaymentService.transitionStatus).not.toHaveBeenCalled();
    });
  });
});
