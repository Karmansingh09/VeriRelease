/**
 * Request Changes on Milestone API Route
 *
 * Endpoint:
 *   POST /api/milestones/[id]/request-changes - Transition milestone to CHANGES_REQUESTED
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authService } from "../../../../../modules/auth";
import { contractService } from "../../../../../modules/contracts";
import { verifyCsrfProtection } from "../../../../../modules/common/csrf";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../../../modules/common/errors";

const requestChangesSchema = z.object({
  reason: z.string().trim().min(5, "Reason must be at least 5 characters"),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    verifyCsrfProtection(req);
    const user = await authService.authenticateRequest(req);
    const { id: milestoneId } = await context.params;

    const body = (await req.json()) as unknown;
    const parsed = requestChangesSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const updated = await contractService.requestChanges(
      milestoneId,
      user.id,
      parsed.data.reason
    );

    return NextResponse.json(
      {
        milestone: {
          ...updated,
          amountMinorUnits: updated.amountMinorUnits.toString(),
        },
      },
      { status: 200 }
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
    if (err instanceof DomainConflictError) {
      return NextResponse.json({ error: "Conflict", message: err.message }, { status: 409 });
    }
    if (err instanceof DomainValidationError) {
      return NextResponse.json({ error: "Validation Error", message: err.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to request changes" },
      { status: 500 }
    );
  }
}
