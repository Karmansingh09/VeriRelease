/**
 * Contracts API Route
 *
 * Endpoints:
 *   GET  /api/contracts - List contracts for authenticated user
 *   POST /api/contracts - Create a new contract
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authService } from "../../../modules/auth";
import { contractService } from "../../../modules/contracts";
import { verifyCsrfProtection } from "../../../modules/common/csrf";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../modules/common/errors";

const createContractSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters"),
  description: z.string().trim().min(5, "Description must be at least 5 characters"),
  developerId: z.string().trim().optional(),
  developerEmail: z.string().email().optional(),
  developerGithubUsername: z.string().trim().optional(),
  totalAmountMinorUnits: z.union([z.string(), z.number(), z.bigint()]).optional(),
  totalAmountUsd: z.union([z.string(), z.number()]).optional(),
  currency: z.enum(["USD", "EUR", "GBP"]).default("USD"),
  githubRepoOwner: z.string().trim().min(1, "GitHub repository owner is required"),
  githubRepoName: z.string().trim().min(1, "GitHub repository name is required"),
});

export async function GET(req: NextRequest) {
  try {
    const user = await authService.authenticateRequest(req);
    const searchParams = req.nextUrl.searchParams;
    const roleParam = searchParams.get("role")?.toUpperCase();
    const filterRole = roleParam === "CLIENT" || roleParam === "DEVELOPER" ? roleParam : undefined;

    const contracts = await contractService.getContractsForUser(user.id, filterRole);

    // Format bigints to strings for JSON serialization
    const formatted = contracts.map((c) => ({
      ...c,
      totalAmountMinorUnits: c.totalAmountMinorUnits.toString(),
      milestones: c.milestones.map((m) => ({
        ...m,
        amountMinorUnits: m.amountMinorUnits.toString(),
      })),
    }));

    return NextResponse.json({ contracts: formatted }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized", message: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to list contracts" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    verifyCsrfProtection(req);
    const user = await authService.authenticateRequest(req);

    const body = (await req.json()) as unknown;
    const parsed = createContractSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const contract = await contractService.createContract(user.id, parsed.data);

    return NextResponse.json(
      {
        contract: {
          ...contract,
          totalAmountMinorUnits: contract.totalAmountMinorUnits.toString(),
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
    if (err instanceof DomainValidationError) {
      return NextResponse.json({ error: "Validation Error", message: err.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to create contract" },
      { status: 500 }
    );
  }
}
