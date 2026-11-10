/**
 * Users API Route
 *
 * Endpoints:
 *   GET   /api/users      - List/search active users (e.g. developers for contract creation)
 *   PATCH /api/users/role - Switch authenticated user's role (CLIENT <-> DEVELOPER) for demo testing
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../lib/prisma";
import { authService } from "../../../modules/auth";
import { verifyCsrfProtection } from "../../../modules/common/csrf";
import {
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../modules/common/errors";

const updateRoleSchema = z.object({
  role: z.enum(["CLIENT", "DEVELOPER", "ADMIN"]),
});

export async function GET(req: NextRequest) {
  try {
    await authService.authenticateRequest(req);
    const query = req.nextUrl.searchParams.get("q") ?? undefined;

    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        ...(query
          ? {
              OR: [
                { email: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
                { githubUsername: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        githubUsername: true,
      },
      take: 20,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ users }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized", message: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to list users" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    verifyCsrfProtection(req);
    const user = await authService.authenticateRequest(req);

    const body = (await req.json()) as unknown;
    const parsed = updateRoleSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: parsed.data.role },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        githubUsername: true,
      },
    });

    return NextResponse.json({ user: updated }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized", message: err.message }, { status: 401 });
    }
    if (err instanceof DomainValidationError) {
      return NextResponse.json({ error: "Validation Error", message: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to update role" },
      { status: 500 }
    );
  }
}
