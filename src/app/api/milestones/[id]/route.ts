/**
 * Single Milestone Detail API Route
 *
 * Endpoint:
 *   GET /api/milestones/[id] - Get detailed milestone view
 */

import { NextRequest, NextResponse } from "next/server";
import { authService } from "../../../../modules/auth";
import { contractService } from "../../../../modules/contracts";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
} from "../../../../modules/common/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const user = await authService.authenticateRequest(req);
    const { id: milestoneId } = await context.params;

    const details = await contractService.getMilestoneDetails(milestoneId, user.id);

    return NextResponse.json(
      {
        milestone: {
          ...details,
          amountMinorUnits: details.amountMinorUnits.toString(),
          contract: {
            ...details.contract,
            totalAmountMinorUnits: details.contract.totalAmountMinorUnits.toString(),
          },
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

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to fetch milestone details" },
      { status: 500 }
    );
  }
}
