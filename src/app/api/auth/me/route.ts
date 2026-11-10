/**
 * VeriRelease Session Verification Endpoint
 *
 * Endpoint:
 *   GET /api/auth/me
 *
 * Returns the currently authenticated user from either an HttpOnly session cookie ('vr_session')
 * or an 'Authorization: Bearer <token>' header.
 */

import { NextRequest, NextResponse } from "next/server";
import { authService } from "../../../../modules/auth";
import { DomainUnauthorizedError } from "../../../../modules/common/errors";

export async function GET(req: NextRequest) {
  try {
    const user = await authService.authenticateRequest(req);

    return NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          githubUsername: user.githubUsername,
          isActive: user.isActive,
        },
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json(
        { error: "Unauthorized", message: err.message },
        { status: 401 }
      );
    }

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to resolve session" },
      { status: 500 }
    );
  }
}
