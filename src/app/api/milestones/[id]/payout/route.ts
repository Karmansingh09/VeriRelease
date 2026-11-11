/**
 * Milestone PayPal Sandbox Payout API Route
 *
 * Endpoints:
 *   POST /api/milestones/[id]/payout - Execute PayPal Sandbox payout for ELIGIBLE_FOR_PAYOUT milestone
 *   GET  /api/milestones/[id]/payout - Retrieve payment transaction history for milestone
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authService } from "../../../../../modules/auth";
import { payoutCoordinator } from "../../../../../modules/payments";
import { verifyCsrfProtection } from "../../../../../modules/common/csrf";
import {
  ConcurrencyConflictError,
  DomainConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
  DuplicatePayoutError,
} from "../../../../../modules/common/errors";

const triggerPayoutSchema = z.object({
  developerPayPalEmail: z.string().email("Invalid PayPal email format").optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    verifyCsrfProtection(req);
    const user = await authService.authenticateRequest(req);
    const { id: milestoneId } = await context.params;

    let body: unknown = {};
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = triggerPayoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const result = await payoutCoordinator.executePayout({
      milestoneId,
      callerId: user.id,
      developerPayPalEmail: parsed.data.developerPayPalEmail,
    });

    const formattedTx = {
      ...result.transaction,
      amountMinorUnits: result.transaction.amountMinorUnits.toString(),
    };

    const status = result.transaction.status === "SUCCEEDED" ? 200 : 202;

    return NextResponse.json(
      {
        payout: {
          ...result,
          transaction: formattedTx,
        },
      },
      { status }
    );
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized", message: err.message }, { status: 401 });
    }
    if (err instanceof DomainForbiddenError) {
      return NextResponse.json({ error: "Forbidden", message: err.message }, { status: 403 });
    }
    if (err instanceof DomainNotFoundError) {
      return NextResponse.json({ error: "Not Found", message: err.message }, { status: 404 });
    }
    if (
      err instanceof DuplicatePayoutError ||
      err instanceof ConcurrencyConflictError ||
      err instanceof DomainConflictError
    ) {
      return NextResponse.json({ error: "Conflict", message: (err as Error).message }, { status: 409 });
    }
    if (err instanceof DomainValidationError) {
      return NextResponse.json({ error: "Validation Error", message: err.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to execute payout" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const user = await authService.authenticateRequest(req);
    const { id: milestoneId } = await context.params;

    const payments = await payoutCoordinator.getMilestonePayments(milestoneId, user.id);

    return NextResponse.json({ payments }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized", message: err.message }, { status: 401 });
    }
    if (err instanceof DomainForbiddenError) {
      return NextResponse.json({ error: "Forbidden", message: err.message }, { status: 403 });
    }
    if (err instanceof DomainNotFoundError) {
      return NextResponse.json({ error: "Not Found", message: err.message }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to retrieve payments" },
      { status: 500 }
    );
  }
}
