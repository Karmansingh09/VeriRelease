/**
 * Fund Milestone API Route
 *
 * Endpoint:
 *   POST /api/milestones/[id]/fund - Transition milestone from DRAFT to FUNDED
 */

import { NextRequest, NextResponse } from "next/server";
import { authService } from "../../../../../modules/auth";
import { contractService } from "../../../../../modules/contracts";
import { verifyCsrfProtection } from "../../../../../modules/common/csrf";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
  InvalidStateTransitionError,
} from "../../../../../modules/common/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    verifyCsrfProtection(req);
    const user = await authService.authenticateRequest(req);
    const { id: milestoneId } = await context.params;

    const updated = await contractService.fundMilestone(milestoneId, user.id);

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
    if (err instanceof InvalidStateTransitionError || err instanceof DomainConflictError) {
      return NextResponse.json({ error: "Conflict", message: (err as Error).message }, { status: 409 });
    }
    if (err instanceof DomainValidationError) {
      return NextResponse.json({ error: "Validation Error", message: err.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to fund milestone" },
      { status: 500 }
    );
  }
}
