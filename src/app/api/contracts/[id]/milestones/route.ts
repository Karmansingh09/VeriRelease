/**
 * Contract Milestones API Route
 *
 * Endpoints:
 *   GET  /api/contracts/[id]/milestones - List milestones for a contract
 *   POST /api/contracts/[id]/milestones - Add a milestone with acceptance criteria
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

const createCriterionSchema = z.object({
  title: z.string().trim().min(3, "Criterion title must be at least 3 characters"),
  description: z.string().trim().min(5, "Criterion description must be at least 5 characters"),
  criterionType: z.enum([
    "AUTOMATED_TEST",
    "FILE_CHANGE",
    "CODE_QUALITY",
    "SPECIFICATION",
    "MANUAL_APPROVAL",
  ]),
  isMandatory: z.boolean().default(true),
  orderIndex: z.number().int().positive().optional(),
});

const createMilestoneSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters"),
  description: z.string().trim().min(5, "Description must be at least 5 characters"),
  orderIndex: z.number().int().positive().optional(),
  amountMinorUnits: z.union([z.string(), z.number(), z.bigint()]).optional(),
  amountUsd: z.union([z.string(), z.number()]).optional(),
  currency: z.enum(["USD", "EUR", "GBP"]).optional(),
  criteria: z.array(createCriterionSchema).optional(),
});

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
        milestones: contract.milestones.map((m) => ({
          ...m,
          amountMinorUnits: m.amountMinorUnits.toString(),
        })),
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
      { error: "Internal Server Error", message: "Failed to list milestones" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    verifyCsrfProtection(req);
    const user = await authService.authenticateRequest(req);
    const { id: contractId } = await context.params;

    const body = (await req.json()) as unknown;
    const parsed = createMilestoneSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const milestone = await contractService.addMilestone(contractId, user.id, parsed.data);

    return NextResponse.json(
      {
        milestone: {
          ...milestone,
          amountMinorUnits: milestone.amountMinorUnits.toString(),
        },
      },
      { status: 201 }
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
      { error: "Internal Server Error", message: "Failed to add milestone" },
      { status: 500 }
    );
  }
}
