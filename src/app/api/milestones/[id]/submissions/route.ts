/**
 * Milestone Submissions API Route
 *
 * Endpoints:
 *   POST /api/milestones/[id]/submissions - Submit PR work for milestone
 *   GET  /api/milestones/[id]/submissions - List submissions for milestone
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
  InvalidStateTransitionError,
} from "../../../../../modules/common/errors";

const createSubmissionSchema = z.object({
  prNumber: z.number().int().positive("prNumber must be a positive integer"),
  prCommitSha: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{40}$/, "prCommitSha must be a 40-character hex commit SHA"),
  prUrl: z.string().trim().url("prUrl must be a valid URL"),
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
    const parsed = createSubmissionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const submission = await contractService.submitMilestoneWork(
      milestoneId,
      user.id,
      parsed.data
    );

    return NextResponse.json({ submission }, { status: 201 });
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
      { error: "Internal Server Error", message: "Failed to create submission" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const user = await authService.authenticateRequest(req);
    const { id: milestoneId } = await context.params;

    const details = await contractService.getMilestoneDetails(milestoneId, user.id);

    return NextResponse.json({ submissions: details.submissions }, { status: 200 });
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
      { error: "Internal Server Error", message: "Failed to list submissions" },
      { status: 500 }
    );
  }
}
