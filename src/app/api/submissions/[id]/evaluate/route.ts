/**
 * Submission Evaluation API Route
 *
 * Endpoints:
 *   POST /api/submissions/[id]/evaluate - Trigger AI evaluation and deterministic policy engine
 *   GET  /api/submissions/[id]/evaluate - Get latest evaluation outcome and evidence summary
 */

import { NextRequest, NextResponse } from "next/server";
import { authService } from "../../../../../modules/auth";
import { aiEvaluationService } from "../../../../../modules/ai";
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
    const { id: submissionId } = await context.params;

    const outcome = await aiEvaluationService.evaluateSubmission(submissionId, user);

    return NextResponse.json({ outcome }, { status: 200 });
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
      { error: "Internal Server Error", message: "Failed to evaluate submission" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    await authService.authenticateRequest(req);
    const { id: submissionId } = await context.params;

    const latest = await aiEvaluationService.getLatestSubmissionEvaluation(submissionId);

    return NextResponse.json({ latest }, { status: 200 });
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
      { error: "Internal Server Error", message: "Failed to fetch evaluation" },
      { status: 500 }
    );
  }
}
