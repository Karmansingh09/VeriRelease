/**
 * PayPal Payout Coordinator & Client Unit Test Suite
 *
 * Covers:
 * - MockPayPalClient order creation, capture, and failure/timeout simulations
 * - RestPayPalClient HTTP error classification (5xx/timeout -> PayPalAmbiguousResponseError)
 * - PayoutCoordinator authorization checks
 * - Strict verification of captured amount and currency against DB intent
 * - Ambiguous provider timeout -> PAYOUT_UNCERTAIN transition (no blind retry)
 * - Duplicate payout replay safety
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockPayPalClient } from "../../src/modules/payments/paypal/mock-paypal-client";
import {
  RestPayPalClient,
  PayPalAmbiguousResponseError,
} from "../../src/modules/payments/paypal/rest-paypal-client";
import { PayoutCoordinator } from "../../src/modules/payments/payout-coordinator";
import {
  DomainForbiddenError,
  DomainNotFoundError,
} from "../../src/modules/common/errors";

describe("PayPal Payout Coordinator Unit Tests", () => {
  const clientUserId = "usr_client_1";
  const devUserId = "usr_dev_1";

  const sampleContract = {
    id: "cnt_1",
    title: "Web Platform",
    clientId: clientUserId,
    developerId: devUserId,
    developer: {
      id: devUserId,
      email: "dev@example.com",
      paypalReceiverEmail: "dev-paypal@example.com",
    },
  };

  const sampleMilestone = {
    id: "mls_1",
    contractId: sampleContract.id,
    title: "Auth System",
    amountMinorUnits: 125000n, // $1,250.00
    currency: "USD",
    status: "ELIGIBLE_FOR_PAYOUT",
    contract: sampleContract,
  };

  let mockPaymentService: any;
  let mockAuditService: any;
  let mockDb: any;

  beforeEach(() => {
    mockPaymentService = {
      reservePayout: vi.fn().mockResolvedValue({
        transaction: {
          id: "pay_1",
          milestoneId: sampleMilestone.id,
          status: "RESERVED",
          amountMinorUnits: 125000n,
          currency: "USD",
        },
        idempotencyKey: "a".repeat(64),
        attemptNumber: 1,
        submissionId: "sub_1",
        isExisting: false,
      }),
      claimProcessing: vi.fn().mockResolvedValue({
        id: "pay_1",
        milestoneId: sampleMilestone.id,
        status: "PROCESSING",
        amountMinorUnits: 125000n,
        currency: "USD",
      }),
      transitionStatus: vi.fn().mockImplementation(async (input) => ({
        id: input.transactionId,
        milestoneId: input.milestoneId,
        status: input.toStatus,
        amountMinorUnits: 125000n,
        currency: "USD",
        paypalOrderId: input.paypalOrderId,
        paypalCaptureId: input.paypalCaptureId,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      })),
    };

    mockAuditService = {
      recordEvent: vi.fn().mockResolvedValue({}),
    };

    mockDb = {
      milestone: {
        findUnique: vi.fn().mockResolvedValue(sampleMilestone),
      },
      paymentTransaction: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: clientUserId, role: "CLIENT" }),
      },
    };
  });

  describe("MockPayPalClient Simulations", () => {
    it("creates and captures a valid Sandbox order matching intended amount", async () => {
      const paypal = new MockPayPalClient();
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      const result = await coordinator.executePayout({
        milestoneId: sampleMilestone.id,
        callerId: clientUserId,
      });

      expect(result.transaction.status).toBe("SUCCEEDED");
      expect(result.paypalOrderId).toMatch(/^ord_sbx_/);
      expect(result.paypalCaptureId).toMatch(/^cap_sbx_/);
      expect(result.providerStatus).toBe("COMPLETED");
      expect(result.isDemoMode).toBe(true);

      // Verifies transitionStatus recorded SUCCEEDED with orderId & captureId
      expect(mockPaymentService.transitionStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          toStatus: "SUCCEEDED",
          paypalOrderId: result.paypalOrderId,
          paypalCaptureId: result.paypalCaptureId,
        })
      );
    });

    it("rejects payout trigger from unauthorized developer or third party", async () => {
      const paypal = new MockPayPalClient();
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      await expect(
        coordinator.executePayout({
          milestoneId: sampleMilestone.id,
          callerId: devUserId, // Developer is NOT allowed to trigger client payout
        })
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("throws NotFound if milestone does not exist", async () => {
      mockDb.milestone.findUnique.mockResolvedValueOnce(null);
      const paypal = new MockPayPalClient();
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      await expect(
        coordinator.executePayout({
          milestoneId: "mls_nonexistent",
          callerId: clientUserId,
        })
      ).rejects.toThrow(DomainNotFoundError);
    });

    it("detects captured amount mismatch and fails safely", async () => {
      const paypal = new MockPayPalClient({ simulateAmountMismatch: true });
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      const result = await coordinator.executePayout({
        milestoneId: sampleMilestone.id,
        callerId: clientUserId,
      });

      expect(result.transaction.status).toBe("FAILED");
      expect(result.providerStatus).toBe("AMOUNT_MISMATCH");
      expect(mockPaymentService.transitionStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          toStatus: "FAILED",
          errorCode: "PAYPAL_AMOUNT_MISMATCH",
        })
      );
    });

    it("handles definitive provider failure cleanly", async () => {
      const paypal = new MockPayPalClient({ simulateFailure: true });
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      const result = await coordinator.executePayout({
        milestoneId: sampleMilestone.id,
        callerId: clientUserId,
      });

      expect(result.transaction.status).toBe("FAILED");
      expect(result.providerStatus).toBe("FAILED");
    });

    it("transitions to PAYOUT_UNCERTAIN on ambiguous timeout without blind retry", async () => {
      const paypal = new MockPayPalClient({ simulateAmbiguousTimeout: true });
      const createSpy = vi.spyOn(paypal, "createOrder");
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      const result = await coordinator.executePayout({
        milestoneId: sampleMilestone.id,
        callerId: clientUserId,
      });

      // Exactly 1 attempt; zero blind retries
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(result.transaction.status).toBe("PAYOUT_UNCERTAIN");
      expect(result.providerStatus).toBe("UNCERTAIN");
      expect(mockPaymentService.transitionStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          toStatus: "PAYOUT_UNCERTAIN",
          action: "PAYMENT_MARKED_UNCERTAIN",
        })
      );
    });

    it("does not re-execute PayPal capture if an existing SUCCEEDED transaction is found", async () => {
      mockPaymentService.reservePayout.mockResolvedValueOnce({
        transaction: {
          id: "pay_existing",
          status: "SUCCEEDED",
          paypalOrderId: "ord_prev_123",
          paypalCaptureId: "cap_prev_123",
          amountMinorUnits: 125000n,
          currency: "USD",
        },
        isExisting: true,
      });

      const paypal = new MockPayPalClient();
      const createSpy = vi.spyOn(paypal, "createOrder");
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      const result = await coordinator.executePayout({
        milestoneId: sampleMilestone.id,
        callerId: clientUserId,
      });

      expect(createSpy).not.toHaveBeenCalled();
      expect(result.transaction.status).toBe("SUCCEEDED");
      expect(result.paypalCaptureId).toBe("cap_prev_123");
    });

    it("blocks retry if previous payout is already in PAYOUT_UNCERTAIN state", async () => {
      mockPaymentService.reservePayout.mockResolvedValueOnce({
        transaction: {
          id: "pay_uncertain",
          status: "PAYOUT_UNCERTAIN",
          paypalOrderId: "ord_unc_123",
          amountMinorUnits: 125000n,
          currency: "USD",
        },
        isExisting: true,
      });

      const paypal = new MockPayPalClient();
      const captureSpy = vi.spyOn(paypal, "captureOrder");
      const coordinator = new PayoutCoordinator(
        mockPaymentService,
        paypal,
        mockAuditService,
        mockDb as any
      );

      const result = await coordinator.executePayout({
        milestoneId: sampleMilestone.id,
        callerId: clientUserId,
      });

      expect(captureSpy).not.toHaveBeenCalled();
      expect(result.providerStatus).toBe("UNCERTAIN");
    });
  });

  describe("RestPayPalClient Error Classification", () => {
    it("throws PayPalAmbiguousResponseError when PayPal returns 5xx error during capture", async () => {
      const fetchMock = vi.fn()
        // 1. OAuth token success
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "tok_123", expires_in: 3600 }), {
            status: 200,
          })
        )
        // 2. Capture 503 Service Unavailable
        .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

      vi.stubGlobal("fetch", fetchMock);

      const restClient = new RestPayPalClient({
        clientId: "cid",
        clientSecret: "csec",
        mode: "sandbox",
      });

      await expect(
        restClient.captureOrder({ orderId: "ord_123", idempotencyKey: "key_1" })
      ).rejects.toThrow(PayPalAmbiguousResponseError);

      vi.unstubAllGlobals();
    });

    it("throws PayPalAmbiguousResponseError when network timeout occurs during capture", async () => {
      const fetchMock = vi.fn()
        // 1. OAuth token success
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "tok_123", expires_in: 3600 }), {
            status: 200,
          })
        )
        // 2. Capture network drop
        .mockRejectedValueOnce(new Error("ECONNRESET"));

      vi.stubGlobal("fetch", fetchMock);

      const restClient = new RestPayPalClient({
        clientId: "cid",
        clientSecret: "csec",
        mode: "sandbox",
      });

      await expect(
        restClient.captureOrder({ orderId: "ord_123" })
      ).rejects.toThrow(PayPalAmbiguousResponseError);

      vi.unstubAllGlobals();
    });
  });
});
