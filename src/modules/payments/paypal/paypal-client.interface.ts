/**
 * PayPal Client Interface
 *
 * Defines the contract for interacting with PayPal Sandbox / Live REST API.
 */

export interface CreatePayPalOrderInput {
  referenceId: string;
  amountMajor: string; // Formatted major units, e.g. "500.00"
  currency: string;
  description: string;
  payeeEmail?: string;
  customId?: string;
}

export interface CreatePayPalOrderResult {
  orderId: string;
  status: string;
  approvalUrl?: string;
  rawResponse: Record<string, unknown>;
}

export interface CapturePayPalOrderInput {
  orderId: string;
  idempotencyKey?: string;
}

export interface CapturePayPalOrderResult {
  captureId: string;
  orderId: string;
  status: "COMPLETED" | "FAILED" | "PENDING";
  capturedAmountMajor: string;
  currency: string;
  rawResponse: Record<string, unknown>;
}

export interface PayPalClient {
  readonly mode: "sandbox" | "live" | "mock";
  createOrder(input: CreatePayPalOrderInput): Promise<CreatePayPalOrderResult>;
  captureOrder(input: CapturePayPalOrderInput): Promise<CapturePayPalOrderResult>;
  getOrder(orderId: string): Promise<Record<string, unknown>>;
}
