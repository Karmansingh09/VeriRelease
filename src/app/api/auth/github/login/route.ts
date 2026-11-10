/**
 * GitHub OAuth Authorization Route
 *
 * Endpoint:
 *   GET /api/auth/github/login
 *   POST /api/auth/github/login
 *
 * Generates an unpredictable cryptographic OAuth state, sets a short-lived
 * HttpOnly state cookie, and redirects the user to GitHub's authorization endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { authService, githubOAuthService } from "../../../../../modules/auth";
import {
  DomainForbiddenError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../../../modules/common/errors";
import { verifyCsrfProtection } from "../../../../../modules/common/csrf";
import { redactSecrets } from "../../../../../modules/common/redact";

export async function GET(req: NextRequest) {
  return handleLogin(req);
}

export async function POST(req: NextRequest) {
  return handleLogin(req);
}

async function handleLogin(req: NextRequest) {
  try {
    if (req.method.toUpperCase() === "POST") {
      verifyCsrfProtection(req);
    }
    const searchParams = req.nextUrl.searchParams;
    const requestedAction = searchParams.get("action");
    const returnTo = searchParams.get("returnTo") ?? undefined;
    const format = searchParams.get("format");

    // Check whether the caller is already authenticated
    let authenticatedUserId: string | undefined = undefined;
    try {
      const user = await authService.authenticateRequest(req);
      authenticatedUserId = user.id;
    } catch {
      // Unauthenticated caller
    }

    // Never allow an unauthenticated request to link an account
    if (requestedAction === "link" && !authenticatedUserId) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: "Must be authenticated with VeriRelease to link a GitHub account",
        },
        { status: 401 }
      );
    }

    const action = requestedAction === "link" ? "link" : "login";

    const { authorizationUrl, cookieHeader } = await githubOAuthService.generateAuthorizationUrl({
      action,
      authenticatedUserId,
      returnTo,
    });

    const isJsonRequested =
      format === "json" || req.headers.get("accept")?.includes("application/json");

    if (isJsonRequested) {
      const res = NextResponse.json({ authorizationUrl }, { status: 200 });
      res.headers.append("Set-Cookie", cookieHeader);
      return res;
    }

    const res = NextResponse.redirect(authorizationUrl, { status: 302 });
    res.headers.append("Set-Cookie", cookieHeader);
    return res;
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json(
        { error: "Unauthorized", message: err.message },
        { status: 401 }
      );
    }
    if (err instanceof DomainForbiddenError) {
      return NextResponse.json(
        { error: "Forbidden", message: err.message },
        { status: 403 }
      );
    }
    if (err instanceof DomainValidationError) {
      return NextResponse.json(
        { error: "Validation Error", message: err.message },
        { status: 400 }
      );
    }

    const rawMessage = err instanceof Error ? err.message : "Internal Server Error";
    console.error("[OAuth Login Error]", redactSecrets(rawMessage));
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to initiate GitHub authorization" },
      { status: 500 }
    );
  }
}
