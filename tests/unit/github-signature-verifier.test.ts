import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookSignatureVerifier } from "../../src/modules/github/webhook/signature-verifier";
import { WebhookSignatureVerificationError } from "../../src/modules/common/errors";

describe("GitHub Webhook Signature Verifier Unit Test Suite", () => {
  const secret = "super_secret_webhook_key_12345678";
  const payload = JSON.stringify({ action: "opened", number: 42, repository: { full_name: "acme/repo" } });

  function sign(body: string, key: string): string {
    return `sha256=${createHmac("sha256", key).update(Buffer.from(body, "utf8")).digest("hex")}`;
  }

  it("successfully verifies a valid HMAC-SHA256 signature over string payload", () => {
    const signature = sign(payload, secret);
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: signature,
        webhookSecret: secret,
      });
    }).not.toThrow();

    expect(
      WebhookSignatureVerifier.isValid({
        rawBody: payload,
        signatureHeader: signature,
        webhookSecret: secret,
      })
    ).toBe(true);
  });

  it("successfully verifies a valid HMAC-SHA256 signature over Buffer payload", () => {
    const buffer = Buffer.from(payload, "utf8");
    const signature = sign(payload, secret);
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: buffer,
        signatureHeader: signature,
        webhookSecret: secret,
      });
    }).not.toThrow();
  });

  it("rejects invalid signature digest mismatch with WebhookSignatureVerificationError", () => {
    const invalidSignature = "sha256=" + "a".repeat(64);
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: invalidSignature,
        webhookSecret: secret,
      });
    }).toThrow(WebhookSignatureVerificationError);

    expect(
      WebhookSignatureVerifier.isValid({
        rawBody: payload,
        signatureHeader: invalidSignature,
        webhookSecret: secret,
      })
    ).toBe(false);
  });

  it("rejects altered raw body even if difference is a single byte or space", () => {
    const validSignatureForOriginal = sign(payload, secret);
    const alteredPayload = payload + " ";

    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: alteredPayload,
        signatureHeader: validSignatureForOriginal,
        webhookSecret: secret,
      });
    }).toThrow(WebhookSignatureVerificationError);
  });

  it("rejects missing signature header", () => {
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: undefined,
        webhookSecret: secret,
      });
    }).toThrow("Missing X-Hub-Signature-256 header");
  });

  it("rejects empty signature header", () => {
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: "   ",
        webhookSecret: secret,
      });
    }).toThrow("Missing X-Hub-Signature-256 header");
  });

  it("rejects malformed signature missing 'sha256=' prefix", () => {
    const hexOnly = createHmac("sha256", secret).update(payload).digest("hex");
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: hexOnly,
        webhookSecret: secret,
      });
    }).toThrow("header must start with 'sha256='");
  });

  it("rejects malformed signature with invalid hex length", () => {
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: "sha256=abcdef12345",
        webhookSecret: secret,
      });
    }).toThrow("expected 64-character hexadecimal digest");
  });

  it("rejects malformed signature with non-hex characters", () => {
    const nonHex = "sha256=" + "z".repeat(64);
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: nonHex,
        webhookSecret: secret,
      });
    }).toThrow("expected 64-character hexadecimal digest");
  });

  it("rejects missing or empty webhook secret", () => {
    const signature = sign(payload, secret);
    expect(() => {
      WebhookSignatureVerifier.verify({
        rawBody: payload,
        signatureHeader: signature,
        webhookSecret: "",
      });
    }).toThrow("Webhook secret is not configured");
  });
});
