/**
 * VeriRelease GitHub Webhook Signature Verifier
 *
 * Implements HMAC-SHA256 signature verification over raw request payloads
 * using constant-time equality checks to prevent timing side-channel attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureVerificationError } from "../../common/errors";

export interface VerifySignatureOptions {
  /**
   * Raw request body as Buffer or string.
   * Signature MUST be validated against the exact unparsed bytes received over HTTP.
   */
  rawBody: Buffer | string;
  /**
   * The signature header value from `x-hub-signature-256`.
   */
  signatureHeader?: string | null;
  /**
   * The shared webhook secret configured for GitHub webhooks.
   */
  webhookSecret: string;
}

export class WebhookSignatureVerifier {
  /**
   * Verifies that the provided X-Hub-Signature-256 matches the HMAC-SHA256 of the raw body.
   *
   * @throws {WebhookSignatureVerificationError} If signature is missing, malformed, or invalid.
   */
  static verify(options: VerifySignatureOptions): void {
    const { rawBody, signatureHeader, webhookSecret } = options;

    if (!webhookSecret || webhookSecret.trim().length === 0) {
      throw new WebhookSignatureVerificationError("Webhook secret is not configured");
    }

    if (!signatureHeader || signatureHeader.trim().length === 0) {
      throw new WebhookSignatureVerificationError("Missing X-Hub-Signature-256 header");
    }

    const trimmedSignature = signatureHeader.trim();
    if (!trimmedSignature.startsWith("sha256=")) {
      throw new WebhookSignatureVerificationError(
        "Malformed signature: header must start with 'sha256='"
      );
    }

    const providedHex = trimmedSignature.slice("sha256=".length);
    if (!/^[0-9a-f]{64}$/i.test(providedHex)) {
      throw new WebhookSignatureVerificationError(
        "Malformed signature: expected 64-character hexadecimal digest"
      );
    }

    // Compute expected HMAC-SHA256 digest
    const hmac = createHmac("sha256", webhookSecret);
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    hmac.update(bodyBuffer);
    const expectedHex = hmac.digest("hex");

    // Constant-time buffer comparison to prevent timing attacks
    const providedBuffer = Buffer.from(providedHex.toLowerCase(), "utf8");
    const expectedBuffer = Buffer.from(expectedHex.toLowerCase(), "utf8");

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      throw new WebhookSignatureVerificationError("Invalid webhook signature: digest mismatch");
    }
  }

  /**
   * Safe boolean check helper without throwing.
   */
  static isValid(options: VerifySignatureOptions): boolean {
    try {
      this.verify(options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper to generate a valid signature (useful for tests and webhook testing).
   */
  static computeSignature(rawBody: Buffer | string, secret: string): string {
    const hmac = createHmac("sha256", secret);
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    hmac.update(bodyBuffer);
    return `sha256=${hmac.digest("hex")}`;
  }
}
