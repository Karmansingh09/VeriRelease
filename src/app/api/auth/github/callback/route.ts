/**
 * GitHub OAuth Callback Route
 *
 * Endpoint:
 *   GET /api/auth/github/callback
 *
 * Receives the authorization code and state from GitHub, verifies state integrity
 * and freshness, exchanges code for access token, fetches verified GitHub profile,
 * resolves/binds identity, and delivers a VeriRelease session via secure HttpOnly cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authService,
  githubOAuthService,
  OAUTH_STATE_COOKIE_NAME,
} from "../../../../../modules/auth";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../../../modules/common/errors";
import { redactSecrets } from "../../../../../modules/common/redact";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  const format = searchParams.get("format");

  const cookieHeader = req.headers.get("cookie");
  const cookieState = authService.extractCookie(cookieHeader, OAUTH_STATE_COOKIE_NAME);

  const clearCookieHeader = githubOAuthService.clearCookieHeader(OAUTH_STATE_COOKIE_NAME);

  // Attempt to resolve active authenticated session from incoming request
  let currentAuthenticatedUser = null;
  try {
    currentAuthenticatedUser = await authService.authenticateRequest(req);
  } catch {
    currentAuthenticatedUser = null;
  }

  try {
    const result = await githubOAuthService.handleCallback({
      code,
      state,
      cookieState,
      currentAuthenticatedUser,
      error,
      errorDescription,
    });

    const isJsonRequested =
      format === "json" ||
      req.headers.get("accept")?.includes("application/json") ||
      req.headers.get("sec-fetch-dest") === "empty";

    if (isJsonRequested) {
      const res = NextResponse.json(
        {
          success: true,
          user: result.user,
        },
        { status: 200 }
      );
      res.headers.append("Set-Cookie", result.sessionCookieHeader);
      res.headers.append("Set-Cookie", result.clearStateCookieHeader);
      return res;
    }

    const redirectTarget = new URL(result.returnTo, req.url);
    const res = NextResponse.redirect(redirectTarget, { status: 302 });
    res.headers.append("Set-Cookie", result.sessionCookieHeader);
    res.headers.append("Set-Cookie", result.clearStateCookieHeader);
    return res;
  } catch (err: unknown) {
    let status = 500;
    let errorType = "Internal Server Error";
    let message = "GitHub OAuth authentication failed";

    if (err instanceof DomainUnauthorizedError) {
      status = 401;
      errorType = "Unauthorized";
      message = err.message;
    } else if (err instanceof DomainForbiddenError) {
      status = 403;
      errorType = "Forbidden";
      message = err.message;
    } else if (err instanceof DomainConflictError) {
      status = 409;
      errorType = "Conflict";
      message = err.message;
    } else if (err instanceof DomainValidationError) {
      status = 400;
      errorType = "Validation Error";
      message = err.message;
    } else {
      const rawMsg = err instanceof Error ? err.message : String(err);
      console.error("[OAuth Callback Error]", redactSecrets(rawMsg));
    }

    const res = NextResponse.json({ error: errorType, message }, { status });
    res.headers.append("Set-Cookie", clearCookieHeader);
    return res;
  }
}
