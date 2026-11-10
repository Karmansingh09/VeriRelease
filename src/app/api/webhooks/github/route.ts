/**
 * GitHub Webhook Ingestion API Route
 *
 * Endpoint: POST /api/webhooks/github
 *
 * Ingests inbound GitHub webhook deliveries with HMAC-SHA256 signature verification,
 * durable delivery tracking, and idempotent duplicate handling.
 */

import { NextRequest, NextResponse } from "next/server";
import { env } from "../../../../lib/env";
import {
  ConcurrencyConflictError,
  DomainValidationError,
  WebhookSignatureVerificationError,
} from "../../../../modules/common/errors";
import { redactSecrets } from "../../../../modules/common/redact";
import {
  WebhookDeliveryService,
} from "../../../../modules/github";

function getWebhookService(): WebhookDeliveryService {
  return new WebhookDeliveryService();
}

export async function POST(req: NextRequest) {
  try {
    const signatureHeader = req.headers.get("x-hub-signature-256");
    const deliveryId = req.headers.get("x-github-delivery");
    const eventType = req.headers.get("x-github-event");

    // Read the exact raw body bytes for HMAC verification
    const rawBuffer = Buffer.from(await req.arrayBuffer());

    const webhookService = getWebhookService();
    const result = await webhookService.ingestWebhook({
      rawBody: rawBuffer,
      signatureHeader,
      deliveryId,
      eventType,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    });

    if (result.outcome === "duplicate") {
      return NextResponse.json(
        {
          status: "duplicate",
          deliveryId: result.delivery.deliveryId,
          message: "Delivery already processed or received",
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        status: "accepted",
        deliveryId: result.delivery.deliveryId,
      },
      { status: 202 }
    );
  } catch (err: unknown) {
    if (err instanceof WebhookSignatureVerificationError) {
      return NextResponse.json(
        { error: "Unauthorized", message: redactSecrets(err.message) },
        { status: 401 }
      );
    }

    if (err instanceof DomainValidationError) {
      return NextResponse.json(
        { error: "Bad Request", message: redactSecrets(err.message) },
        { status: 400 }
      );
    }

    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json(
        { error: "Conflict", message: redactSecrets(err.message) },
        { status: 409 }
      );
    }

    const rawMessage = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: "Internal Server Error", message: redactSecrets(rawMessage) },
      { status: 500 }
    );
  }
}
