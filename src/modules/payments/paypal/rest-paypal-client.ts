/**
 * VeriRelease Official PayPal REST API Client
 *
 * Implements server-side interaction with PayPal Sandbox REST API:
 * - OAuth 2.0 Client Credentials token acquisition and caching
 * - Order creation (intent: CAPTURE)
 * - Order capture with PayPal-Request-Id idempotency
 * - Distinguishes definitive rejection from network timeout / ambiguous responses
 *
 * CRITICAL SECURITY INVARIANTS:
 * - Credentials and access tokens are kept strictly server-side.
 * - Uses PayPal Sandbox endpoints by default.
 * - Ambiguous network responses throw AmbiguousProviderError (never blindly retried).
 */

import { DomainValidationError } from "../../common/errors";
import type {
  PayPalClient,
  CreatePayPalOrderInput,
  CreatePayPalOrderResult,
  CapturePayPalOrderInput,
  CapturePayPalOrderResult,
} from "./paypal-client.interface";

export class PayPalAmbiguousResponseError extends Error {
  constructor(
    message: string,
    public readonly orderId?: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "PayPalAmbiguousResponseError";
  }
}

interface PayPalLink {
  rel?: string;
  href?: string;
}

interface PayPalCreateOrderApiResponse {
  id: string;
  status: string;
  links?: PayPalLink[];
  [key: string]: unknown;
}

interface PayPalCaptureEntry {
  id?: string;
  status?: string;
  amount?: {
    value?: string;
    currency_code?: string;
  };
}

interface PayPalCaptureApiResponse {
  id: string;
  status: string;
  purchase_units?: Array<{
    payments?: {
      captures?: PayPalCaptureEntry[];
    };
  }>;
  [key: string]: unknown;
}

export interface RestPayPalClientConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  mode?: "sandbox" | "live";
}

export class RestPayPalClient implements PayPalClient {
  readonly mode: "sandbox" | "live";
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  // Cached OAuth token
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(config: RestPayPalClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.mode = config.mode ?? "sandbox";
    this.baseUrl =
      config.baseUrl ??
      (this.mode === "sandbox"
        ? "https://api-m.sandbox.paypal.com"
        : "https://api-m.paypal.com");
  }

  /**
   * Retrieves or refreshes OAuth 2.0 access token via client credentials.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60000) {
      return this.cachedToken.token;
    }

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    try {
      const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`PayPal OAuth authentication failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };
      this.cachedToken = {
        token: data.access_token,
        expiresAt: now + data.expires_in * 1000,
      };

      return data.access_token;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("PayPal OAuth")) throw err;
      throw new PayPalAmbiguousResponseError(
        "Failed to reach PayPal OAuth endpoint (network timeout or connection error)",
        undefined,
        err
      );
    }
  }

  /**
   * Creates a PayPal order with intent: CAPTURE.
   */
  async createOrder(input: CreatePayPalOrderInput): Promise<CreatePayPalOrderResult> {
    const token = await this.getAccessToken();

    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.referenceId,
          description: input.description,
          custom_id: input.customId,
          amount: {
            currency_code: input.currency,
            value: input.amountMajor,
          },
          ...(input.payeeEmail
            ? {
                payee: {
                  email_address: input.payeeEmail,
                },
              }
            : {}),
        },
      ],
    };

    try {
      const response = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new DomainValidationError(`PayPal Order creation failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as PayPalCreateOrderApiResponse;
      const approvalUrl = data.links?.find((l: PayPalLink) => l.rel === "approve")?.href;

      return {
        orderId: data.id,
        status: data.status,
        approvalUrl,
        rawResponse: data,
      };
    } catch (err: unknown) {
      if (err instanceof DomainValidationError) throw err;
      throw new PayPalAmbiguousResponseError(
        "Ambiguous outcome during PayPal order creation (network failure or timeout)",
        undefined,
        err
      );
    }
  }

  /**
   * Captures payment for an authorized PayPal order.
   * Uses PayPal-Request-Id header to guarantee provider-level idempotency.
   */
  async captureOrder(input: CapturePayPalOrderInput): Promise<CapturePayPalOrderResult> {
    const token = await this.getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };

    if (input.idempotencyKey) {
      headers["PayPal-Request-Id"] = input.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v2/checkout/orders/${input.orderId}/capture`, {
        method: "POST",
        headers,
      });
    } catch (networkErr: unknown) {
      // Network timeout or drop during capture is strictly an UNCERTAIN outcome!
      throw new PayPalAmbiguousResponseError(
        `Network error during capture of PayPal order '${input.orderId}'. Outcome is uncertain.`,
        input.orderId,
        networkErr
      );
    }

    // 5xx Server Error from PayPal also means uncertain outcome
    if (response.status >= 500) {
      const errorText = await response.text();
      throw new PayPalAmbiguousResponseError(
        `PayPal 5xx server error during order capture (${response.status}): ${errorText}`,
        input.orderId
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new DomainValidationError(`PayPal capture failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as PayPalCaptureApiResponse;
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];

    const captureId = capture?.id ?? data.id;
    const captureStatus = (capture?.status ?? data.status) as "COMPLETED" | "FAILED" | "PENDING";
    const capturedAmountMajor = capture?.amount?.value ?? "0.00";
    const currency = capture?.amount?.currency_code ?? "USD";

    return {
      captureId,
      orderId: input.orderId,
      status: captureStatus,
      capturedAmountMajor,
      currency,
      rawResponse: data,
    };
  }

  /**
   * Retrieves order details directly from PayPal.
   */
  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();

    const response = await fetch(`${this.baseUrl}/v2/checkout/orders/${orderId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch PayPal order (${response.status}): ${errorText}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}
