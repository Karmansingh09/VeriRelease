/**
 * Single Contract API Route
 *
 * Endpoint:
 *   GET /api/contracts/[id] - Get contract details by ID
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
    const { id: contractId } = await context.params;

    const contract = await contractService.getContractById(contractId, user.id);

    return NextResponse.json(
      {
        contract: {
          ...contract,
          totalAmountMinorUnits: contract.totalAmountMinorUnits.toString(),
          milestones: contract.milestones.map((m) => ({
            ...m,
            amountMinorUnits: m.amountMinorUnits.toString(),
          })),
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
      { error: "Internal Server Error", message: "Failed to fetch contract" },
      { status: 500 }
    );
  }
}
