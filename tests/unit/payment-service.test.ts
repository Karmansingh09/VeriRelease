import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentCoordinatorService } from "../../src/modules/payments/payment-service";
import type { PaymentRepository } from "../../src/modules/payments/payment-repository.interface";
import type { PaymentTransaction, PaymentTxStatus } from "../../src/modules/payments/types";
import type { AuditService } from "../../src/modules/audit/audit-service.interface";
import {
  ConcurrencyConflictError,
  DomainNotFoundError,
  DomainValidationError,
  DuplicatePayoutError,
  InvalidMoneyError,
  InvalidStateTransitionError,
  UnsupportedCurrencyError,
} from "../../src/modules/common/errors";
import type { DbClient } from "../../src/lib/prisma";

describe("PaymentCoordinatorService Unit Tests", () => {
  let mockPaymentRepo: PaymentRepository;
  let mockAuditService: AuditService;
  let mockPrisma: any;
  let paymentService: PaymentCoordinatorService;

  const validMilestone = {
    id: "ms_unit_01",
    status: "ELIGIBLE_FOR_PAYOUT",
    amountMinorUnits: 500000n,
    currency: "USD",
  };

  const validSubmission = {
    id: "sub_unit_01",
    criteriaHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    submissionNumber: 1,
  };

  const validEvaluation = {
    id: "eval_unit_01",
    decision: "PASS",
    status: "COMPLETED",
    criteriaHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evaluationNumber: 1,
  };

  beforeEach(() => {
    mockPaymentRepo = {
      createTransaction: vi.fn().mockImplementation(async (input) => {
        const tx: PaymentTransaction = {
          id: input.id ?? "tx_mock_001",
          milestoneId: input.milestoneId,
          submissionId: input.submissionId ?? null,
          transactionType: input.transactionType,
          status: input.status ?? "RESERVED",
          idempotencyKey: input.idempotencyKey,
          amountMinorUnits: input.amountMinorUnits,
          currency: input.currency,
          attemptNumber: input.attemptNumber,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return tx;
      }),
      updateStatus: vi.fn().mockImplementation(async (id, milestoneId, fromStatus, toStatus) => {
        return {
          id,
          milestoneId,
          submissionId: "sub_unit_01",
          transactionType: "PAYOUT" as const,
          status: toStatus,
          idempotencyKey: "mock_key",
          amountMinorUnits: 500000n,
          currency: "USD" as const,
          attemptNumber: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
      findById: vi.fn(),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      findActiveByMilestoneId: vi.fn().mockResolvedValue(null),
      findSucceededPayoutByMilestoneId: vi.fn().mockResolvedValue(null),
      findByMilestoneId: vi.fn().mockResolvedValue([]),
      getNextAttemptNumber: vi.fn().mockResolvedValue(1),
    };

    mockAuditService = {
      recordEvent: vi.fn().mockResolvedValue({
        auditLog: { id: "aud_001" },
        eventHash: "hash_001",
      }),
      computeEventHash: vi.fn().mockReturnValue("hash_001"),
      getEventsForEntity: vi.fn().mockResolvedValue([]),
      getEventsByCorrelationId: vi.fn().mockResolvedValue([]),
    };

    mockPrisma = {
      $transaction: vi.fn().mockImplementation(async (callback: any) => {
        return callback(mockPrisma);
      }),
      $queryRaw: vi.fn().mockImplementation(async (query: any, ...args: any[]) => {
        const queryStr = Array.isArray(query) ? query.join(" ") : String(query);

        if (queryStr.includes('FROM "Milestone"')) {
          return [validMilestone];
        }
        if (queryStr.includes('FROM "PaymentTransaction"') && queryStr.includes("SUCCEEDED")) {
          return []; // no succeeded payout by default
        }
        if (queryStr.includes('FROM "PaymentTransaction"') && queryStr.includes('WHERE id =')) {
          return [{
            id: "tx_mock_001",
            milestoneId: "ms_unit_01",
            transactionType: "PAYOUT",
            status: "RESERVED",
          }];
        }
        if (queryStr.includes('FROM "MilestoneSubmission"')) {
          return [validSubmission];
        }
        if (queryStr.includes('FROM "PolicyEvaluation"')) {
          return [validEvaluation];
        }
        return [];
      }),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    paymentService = new PaymentCoordinatorService(
      mockPaymentRepo,
      mockAuditService,
      mockPrisma as unknown as DbClient
    );
  });

  // 1. Successful Payout Reservation
  it("Requirement 1: Reserves a payout for an ELIGIBLE_FOR_PAYOUT milestone with canonical idempotency key and attempt 1", async () => {
    const result = await paymentService.reservePayout({
      milestoneId: "ms_unit_01",
      developerPayPalEmail: "developer@example.com",
    });

    expect(result.transaction).toBeDefined();
    expect(result.transaction.status).toBe("RESERVED");
    expect(result.transaction.amountMinorUnits).toBe(500000n);
    expect(result.attemptNumber).toBe(1);
    expect(result.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.isExisting).toBe(false);

    expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_RESERVED",
        entityType: "PAYMENT",
        actorType: "SYSTEM",
      }),
      expect.anything()
    );
  });

  // 2. Idempotent Retry Returns Existing Transaction
  it("Requirement 2: Repeated request with the same idempotency key and matching parameters returns existing transaction", async () => {
    const existingTx: PaymentTransaction = {
      id: "tx_existing_01",
      milestoneId: "ms_unit_01",
      submissionId: "sub_unit_01",
      transactionType: "PAYOUT",
      status: "RESERVED",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      amountMinorUnits: 500000n,
      currency: "USD",
      attemptNumber: 1,
      rawRequest: { recipient: "developer@example.com" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockPaymentRepo.findByIdempotencyKey as any).mockResolvedValueOnce(existingTx);

    const result = await paymentService.reservePayout({
      milestoneId: "ms_unit_01",
      developerPayPalEmail: "developer@example.com",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
    });

    expect(result.isExisting).toBe(true);
    expect(result.transaction.id).toBe("tx_existing_01");
    expect(mockPaymentRepo.createTransaction).not.toHaveBeenCalled();
  });

  // 2b. Recipient comparison is case-insensitive and ignores surrounding whitespace
  it("Requirement 2b: Recipient comparison is case-insensitive and ignores surrounding whitespace", async () => {
    const existingTx: PaymentTransaction = {
      id: "tx_existing_01",
      milestoneId: "ms_unit_01",
      submissionId: "sub_unit_01",
      transactionType: "PAYOUT",
      status: "RESERVED",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      amountMinorUnits: 500000n,
      currency: "USD",
      attemptNumber: 1,
      rawRequest: { recipient: "developer@example.com" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockPaymentRepo.findByIdempotencyKey as any).mockResolvedValueOnce(existingTx);

    const result = await paymentService.reservePayout({
      milestoneId: "ms_unit_01",
      developerPayPalEmail: "   Developer@Example.COM   ",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
    });

    expect(result.isExisting).toBe(true);
    expect(result.transaction.id).toBe("tx_existing_01");
  });

  // 3. Reusing Idempotency Key with Different Parameters Fails
  it("Requirement 3: Reusing the same idempotency key with different parameters is rejected with ConcurrencyConflictError", async () => {
    const existingTx: PaymentTransaction = {
      id: "tx_existing_01",
      milestoneId: "ms_DIFFERENT",
      submissionId: "sub_unit_01",
      transactionType: "PAYOUT",
      status: "RESERVED",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      amountMinorUnits: 500000n,
      currency: "USD",
      attemptNumber: 1,
      rawRequest: { recipient: "developer@example.com" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockPaymentRepo.findByIdempotencyKey as any).mockResolvedValueOnce(existingTx);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 3b. Reusing existing key with a different recipient email throws ConcurrencyConflictError
  it("Requirement 3b: Reusing existing key with a different recipient email throws ConcurrencyConflictError", async () => {
    const existingTx: PaymentTransaction = {
      id: "tx_existing_01",
      milestoneId: "ms_unit_01",
      submissionId: "sub_unit_01",
      transactionType: "PAYOUT",
      status: "RESERVED",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      amountMinorUnits: 500000n,
      currency: "USD",
      attemptNumber: 1,
      rawRequest: { recipient: "original-dev@example.com" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockPaymentRepo.findByIdempotencyKey as any).mockResolvedValueOnce(existingTx);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "different-dev@example.com",
        idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 3c. Reusing existing key belonging to a non-PAYOUT transaction is rejected
  it("Requirement 3c: Reusing an existing key belonging to a non-PAYOUT transaction is rejected", async () => {
    const existingTx: PaymentTransaction = {
      id: "tx_existing_01",
      milestoneId: "ms_unit_01",
      submissionId: "sub_unit_01",
      transactionType: "FUNDING_AUTHORIZATION",
      status: "RESERVED",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      amountMinorUnits: 500000n,
      currency: "USD",
      attemptNumber: 1,
      rawRequest: { recipient: "developer@example.com" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockPaymentRepo.findByIdempotencyKey as any).mockResolvedValueOnce(existingTx);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 3d. Reusing existing key with missing or malformed persisted rawRequest throws ConcurrencyConflictError
  it("Requirement 3d: Reusing an existing key with missing or malformed rawRequest is rejected", async () => {
    const existingTx: PaymentTransaction = {
      id: "tx_existing_01",
      milestoneId: "ms_unit_01",
      submissionId: "sub_unit_01",
      transactionType: "PAYOUT",
      status: "RESERVED",
      idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      amountMinorUnits: 500000n,
      currency: "USD",
      attemptNumber: 1,
      rawRequest: null, // missing rawRequest
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockPaymentRepo.findByIdempotencyKey as any).mockResolvedValueOnce(existingTx);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "1111111111111111111111111111111111111111111111111111111111111111",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 3e. Invalid supplied idempotency key throws DomainValidationError
  it("Requirement 3e: An invalid supplied idempotency key throws DomainValidationError", async () => {
    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "invalid-short-key",
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "111111111111111111111111111111111111111111111111111111111111111G", // non-hex
      })
    ).rejects.toThrow(DomainValidationError);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // uppercase
      })
    ).rejects.toThrow(DomainValidationError);
  });

  // 4. Milestone Not in ELIGIBLE_FOR_PAYOUT Rejected
  it("Requirement 4: Milestone not in ELIGIBLE_FOR_PAYOUT status is rejected with ConcurrencyConflictError", async () => {
    mockPrisma.$queryRaw.mockImplementationOnce(async () => [
      { ...validMilestone, status: "SUBMITTED" },
    ]);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 5. Non-existent Milestone Fails
  it("Requirement 5: Non-existent milestone throws DomainNotFoundError", async () => {
    mockPrisma.$queryRaw.mockImplementationOnce(async () => []);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_non_existent",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(DomainNotFoundError);
  });

  // 6. Mismatched Submission Assertion Rejected
  it("Requirement 6: Caller-supplied submissionId not matching latest submission is rejected", async () => {
    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        submissionId: "sub_WRONG_ID",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 7. Latest Evaluation Still IN_PROGRESS or FAILED Rejected
  it("Requirement 7: Payout reservation fails if latest PolicyEvaluation is IN_PROGRESS or FAIL", async () => {
    // IN_PROGRESS
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const q = String(query);
      if (q.includes('FROM "Milestone"')) return [validMilestone];
      if (q.includes('FROM "MilestoneSubmission"')) return [validSubmission];
      if (q.includes('FROM "PolicyEvaluation"')) {
        return [{ ...validEvaluation, status: "IN_PROGRESS", decision: null }];
      }
      return [];
    });

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(ConcurrencyConflictError);

    // FAIL decision
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const q = String(query);
      if (q.includes('FROM "Milestone"')) return [validMilestone];
      if (q.includes('FROM "MilestoneSubmission"')) return [validSubmission];
      if (q.includes('FROM "PolicyEvaluation"')) {
        return [{ ...validEvaluation, status: "COMPLETED", decision: "FAIL" }];
      }
      return [];
    });

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 8. Criteria Hash Mismatch Rejected
  it("Requirement 8: Mismatched criteria hash between submission and evaluation is rejected", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const q = String(query);
      if (q.includes('FROM "Milestone"')) return [validMilestone];
      if (q.includes('FROM "MilestoneSubmission"')) return [validSubmission];
      if (q.includes('FROM "PolicyEvaluation"')) {
        return [{ ...validEvaluation, criteriaHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }];
      }
      return [];
    });

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 9. Existing Succeeded Payout Blocks New Reservation
  it("Requirement 9: Milestone already having a SUCCEEDED payout throws DuplicatePayoutError", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const q = String(query);
      if (q.includes('FROM "Milestone"')) return [validMilestone];
      if (q.includes('FROM "PaymentTransaction"') && q.includes("SUCCEEDED")) {
        return [{ id: "tx_prev_succeeded_01" }];
      }
      return [];
    });

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(DuplicatePayoutError);
  });

  // 10. Conflicting Active Payment Blocks New Reservation
  it("Requirement 10: Active reservation prevents creating a new reservation even with a different idempotency key", async () => {
    (mockPaymentRepo.findActiveByMilestoneId as any).mockResolvedValueOnce({
      id: "tx_active_01",
      status: "RESERVED",
    });

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
        idempotencyKey: "2222222222222222222222222222222222222222222222222222222222222222",
      })
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  // 11. Zero or Negative Amount Rejected
  it("Requirement 11: Milestone with zero or negative amount throws InvalidMoneyError", async () => {
    mockPrisma.$queryRaw.mockImplementationOnce(async () => [
      { ...validMilestone, amountMinorUnits: 0n },
    ]);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(InvalidMoneyError);
  });

  // 12. Unsupported Currency Rejected
  it("Requirement 12: Unsupported currency throws UnsupportedCurrencyError", async () => {
    mockPrisma.$queryRaw.mockImplementationOnce(async () => [
      { ...validMilestone, currency: "XYZ" },
    ]);

    await expect(
      paymentService.reservePayout({
        milestoneId: "ms_unit_01",
        developerPayPalEmail: "developer@example.com",
      })
    ).rejects.toThrow(UnsupportedCurrencyError);
  });

  // 13. Processing Claim (RESERVED -> PROCESSING)
  it("Requirement 13: claimProcessing transitions RESERVED to PROCESSING atomically and records audit event", async () => {
    const claimed = await paymentService.claimProcessing({
      transactionId: "tx_mock_001",
      milestoneId: "ms_unit_01",
    });

    expect(claimed.status).toBe("PROCESSING");
    expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
      "tx_mock_001",
      "ms_unit_01",
      "RESERVED",
      "PROCESSING",
      {},
      expect.anything()
    );
    expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_PROCESSING_STARTED",
        entityType: "PAYMENT",
      }),
      expect.anything()
    );
  });

  // 14. Illegal State Transition Throws InvalidStateTransitionError
  it("Requirement 14: Illegal payment transitions throw InvalidStateTransitionError", async () => {
    await expect(
      paymentService.transitionStatus({
        transactionId: "tx_mock_001",
        milestoneId: "ms_unit_01",
        fromStatus: "CREATED",
        toStatus: "PROCESSING", // Prohibited: must go CREATED -> RESERVED -> PROCESSING
      })
    ).rejects.toThrow(InvalidStateTransitionError);

    await expect(
      paymentService.transitionStatus({
        transactionId: "tx_mock_001",
        milestoneId: "ms_unit_01",
        fromStatus: "RESERVED",
        toStatus: "SUCCEEDED", // Prohibited: must go through PROCESSING
      })
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // 15. Ambiguity Handling: PROCESSING -> PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED
  it("Requirement 15: Handles ambiguous outcomes via PAYOUT_UNCERTAIN and RECONCILIATION_REQUIRED", async () => {
    // 1. PROCESSING -> PAYOUT_UNCERTAIN
    mockPrisma.$queryRaw.mockImplementation(async () => [
      { id: "tx_mock_001", milestoneId: "ms_unit_01", transactionType: "PAYOUT", status: "PROCESSING" },
    ]);

    const uncertain = await paymentService.transitionStatus({
      transactionId: "tx_mock_001",
      milestoneId: "ms_unit_01",
      fromStatus: "PROCESSING",
      toStatus: "PAYOUT_UNCERTAIN",
      errorCode: "GATEWAY_TIMEOUT",
    });

    expect(uncertain.status).toBe("PAYOUT_UNCERTAIN");

    // 2. PAYOUT_UNCERTAIN -> RECONCILIATION_REQUIRED
    mockPrisma.$queryRaw.mockImplementation(async () => [
      { id: "tx_mock_001", milestoneId: "ms_unit_01", transactionType: "PAYOUT", status: "PAYOUT_UNCERTAIN" },
    ]);

    const reconciliation = await paymentService.transitionStatus({
      transactionId: "tx_mock_001",
      milestoneId: "ms_unit_01",
      fromStatus: "PAYOUT_UNCERTAIN",
      toStatus: "RECONCILIATION_REQUIRED",
    });

    expect(reconciliation.status).toBe("RECONCILIATION_REQUIRED");
  });

  // 16. Shared Locking Protocol on SUCCEEDED Payout Transition
  it("Requirement 16: Transitioning to SUCCEEDED acquires milestone lock and rejects duplicate succeeded payout", async () => {
    // Simulate duplicate succeeded payout found
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const q = String(query);
      if (q.includes('FROM "Milestone"')) {
        return [{ id: "ms_unit_01" }];
      }
      if (q.includes('FROM "PaymentTransaction"') && q.includes('status = \'SUCCEEDED\'')) {
        return [{ id: "tx_another_succeeded" }];
      }
      if (q.includes('FROM "PaymentTransaction"')) {
        return [{
          id: "tx_mock_001",
          milestoneId: "ms_unit_01",
          transactionType: "PAYOUT",
          status: "PROCESSING",
        }];
      }
      return [];
    });

    await expect(
      paymentService.transitionStatus({
        transactionId: "tx_mock_001",
        milestoneId: "ms_unit_01",
        fromStatus: "PROCESSING",
        toStatus: "SUCCEEDED",
      })
    ).rejects.toThrow(DuplicatePayoutError);
  });
});
