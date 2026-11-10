/**
 * VeriRelease Session Logout Endpoint
 *
 * Endpoint:
 *   POST /api/auth/logout
 *
 * Clears the secure HttpOnly session cookie ('vr_session').
 */

import { NextRequest, NextResponse } from "next/server";
import { githubOAuthService, SESSION_COOKIE_NAME } from "../../../../modules/auth";
import { verifyCsrfProtection, DomainForbiddenError } from "../../../../modules/common";

export async function POST(req: NextRequest) {
  try {
    verifyCsrfProtection(req);
  } catch (err: unknown) {
    if (err instanceof DomainForbiddenError) {
      return NextResponse.json(
        { error: "Forbidden", message: err.message },
        { status: 403 }
      );
    }
    throw err;
  }

  const clearCookieHeader = githubOAuthService.clearCookieHeader(SESSION_COOKIE_NAME);

  const res = NextResponse.json(
    {
      success: true,
      message: "Logged out successfully",
    },
    { status: 200 }
  );

  res.headers.append("Set-Cookie", clearCookieHeader);
  return res;
}
