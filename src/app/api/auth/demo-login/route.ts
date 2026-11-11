/**
 * Sandbox Demo Session Endpoint
 *
 * Endpoint:
 *   POST /api/auth/demo-login
 *
 * Issues a cryptographically signed VeriRelease HttpOnly session cookie ('vr_session')
 * for one of two fixed hackathon demo personas ('client' or 'developer').
 *
 * SECURITY CONTROLS:
 * - Strictly disabled in production unless ENABLE_DEMO_AUTH="true" is explicitly configured.
 * - Never trusts arbitrary userId/role overrides; maps strictly to fixed demo personas.
 * - Enforces CSRF Origin/Referer verification.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../../lib/prisma";
import { env } from "../../../../lib/env";
import { authService, DEFAULT_TOKEN_TTL_SECONDS, SESSION_COOKIE_NAME } from "../../../../modules/auth";
import { verifyCsrfProtection } from "../../../../modules/common/csrf";
import { DomainForbiddenError } from "../../../../modules/common/errors";

const demoLoginSchema = z.object({
  persona: z.enum(["client", "developer"]),
});

const DEMO_PERSONAS = {
  client: {
    id: "usr_demo_client_verirelease",
    email: "alice.client@verirelease.demo",
    name: "Alice Chen (Demo Client)",
    role: "CLIENT",
    githubUsername: "alice-verirelease",
    paypalReceiverEmail: null,
  },
  developer: {
    id: "usr_demo_dev_verirelease",
    email: "bob.dev@verirelease.demo",
    name: "Bob Rivera (Demo Dev)",
    role: "DEVELOPER",
    githubUsername: "bob-verirelease",
    paypalReceiverEmail: "sb-bob-dev@business.example.com",
  },
} as const;

function isDemoAuthAllowed(): boolean {
  if (process.env.ENABLE_DEMO_AUTH === "true") {
    return true;
  }
  const githubOAuthConfigured = Boolean(
    env.GITHUB_OAUTH_CLIENT_ID &&
      !env.GITHUB_OAUTH_CLIENT_ID.includes("placeholder") &&
      !env.GITHUB_OAUTH_CLIENT_ID.includes("your_")
  );
  return env.NODE_ENV !== "production" && !githubOAuthConfigured;
}

export async function POST(req: NextRequest) {
  try {
    verifyCsrfProtection(req);

    if (!isDemoAuthAllowed()) {
      return NextResponse.json(
        {
          error: "Forbidden",
          message: "Demo authentication is disabled when live OAuth is configured in production",
        },
        { status: 403 }
      );
    }

    const body = (await req.json()) as unknown;
    const parsed = demoLoginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const profile = DEMO_PERSONAS[parsed.data.persona];

    const user = await prisma.user.upsert({
      where: { email: profile.email },
      update: {
        name: profile.name,
        role: profile.role,
        githubUsername: profile.githubUsername,
        paypalReceiverEmail: profile.paypalReceiverEmail,
        isActive: true,
      },
      create: {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        role: profile.role,
        githubUsername: profile.githubUsername,
        paypalReceiverEmail: profile.paypalReceiverEmail,
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        githubUsername: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    const token = authService.generateToken(user.id, {
      tokenVersion: user.tokenVersion,
    });

    const secureFlag = env.NODE_ENV === "production" ? "; Secure" : "";
    const sessionCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      token
    )}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${DEFAULT_TOKEN_TTL_SECONDS}${secureFlag}`;

    const res = NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          githubUsername: user.githubUsername,
          isActive: user.isActive,
        },
        isDemoSession: true,
      },
      { status: 200 }
    );

    res.headers.append("Set-Cookie", sessionCookieHeader);
    return res;
  } catch (err: unknown) {
    if (err instanceof DomainForbiddenError) {
      return NextResponse.json({ error: "Forbidden", message: err.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to start demo session" },
      { status: 500 }
    );
  }
}
