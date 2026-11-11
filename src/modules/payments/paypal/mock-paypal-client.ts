/**
 * VeriRelease Deterministic Mock PayPal Client
 *
 * Provides a high-fidelity local Sandbox simulation for hackathon demonstrations
 * and unit/integration testing without requiring live PayPal Sandbox secrets.
 *
 * Features:
 * - Deterministic order creation (`ord_sbx_...`) and capture (`cap_sbx_...`)
 * - Simulates capture status: COMPLETED, FAILED, or PENDING
 * - Configurable failure simulation for testing uncertain outcomes and recovery
 * - Marked explicitly as `mode: "mock"`
 */

import { randomUUID } from "node:crypto";
import type {
  PayPalClient,
  CreatePayPalOrderInput,
  CreatePayPalOrderResult,
  CapturePayPalOrderInput,
  CapturePayPalOrderResult,
} from "./paypal-client.interface";
import { PayPalAmbiguousResponseError } from "./rest-paypal-client";

export interface MockPayPalOptions {
  simulateFailure?: boolean;
  simulateAmbiguousTimeout?: boolean;
  simulateAmountMismatch?: boolean;
}

export class MockPayPalClient implements PayPalClient {
  readonly mode = "mock";
  private orders: Map<string, { input: CreatePayPalOrderInput; status: string }> = new Map();

  constructor(private readonly options: MockPayPalOptions = {}) {}

  async createOrder(input: CreatePayPalOrderInput): Promise<CreatePayPalOrderResult> {
    if (this.options.simulateAmbiguousTimeout) {
      throw new PayPalAmbiguousResponseError("Simulated network timeout during PayPal order creation");
    }

    const orderId = `ord_sbx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.orders.set(orderId, { input, status: "CREATED" });

    return {
      orderId,
      status: "CREATED",
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      rawResponse: {
        id: orderId,
        status: "CREATED",
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.referenceId,
            amount: {
              currency_code: input.currency,
              value: input.amountMajor,
            },
          },
        ],
      },
    };
  }

  async captureOrder(input: CapturePayPalOrderInput): Promise<CapturePayPalOrderResult> {
    if (this.options.simulateAmbiguousTimeout) {
      throw new PayPalAmbiguousResponseError(
        `Simulated network timeout during capture of order '${input.orderId}'. Outcome is uncertain.`,
        input.orderId
      );
    }

    if (this.options.simulateFailure) {
      return {
        captureId: `cap_sbx_failed_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        orderId: input.orderId,
        status: "FAILED",
        capturedAmountMajor: "0.00",
        currency: "USD",
        rawResponse: {
          id: input.orderId,
          status: "COMPLETED",
          details: [{ issue: "INSTRUMENT_DECLINED", description: "Payment declined by issuing bank" }],
        },
      };
    }

    const order = this.orders.get(input.orderId);
    const amountMajor = this.options.simulateAmountMismatch
      ? "1.00" // Simulated mismatch
      : order?.input.amountMajor ?? "500.00";
    const currency = order?.input.currency ?? "USD";

    const captureId = `cap_sbx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    return {
      captureId,
      orderId: input.orderId,
      status: "COMPLETED",
      capturedAmountMajor: amountMajor,
      currency,
      rawResponse: {
        id: input.orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: captureId,
                  status: "COMPLETED",
                  amount: {
                    currency_code: currency,
                    value: amountMajor,
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    const order = this.orders.get(orderId);
    return {
      id: orderId,
      status: order?.status ?? "COMPLETED",
    };
  }
}
