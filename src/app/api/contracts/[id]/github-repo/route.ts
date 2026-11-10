/**
 * Contract GitHub Repository Association API Route
 *
 * Endpoint:
 *   POST /api/contracts/[id]/github-repo - Associates an authorized GitHub repository with a contract
 *   GET  /api/contracts/[id]/github-repo - Retrieves the associated repository metadata
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "../../../../../lib/env";
import { authService } from "../../../../../modules/auth";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../../../modules/common/errors";
import { verifyCsrfProtection } from "../../../../../modules/common/csrf";
import { redactSecrets } from "../../../../../modules/common/redact";
import {
  FetchGitHubProvider,
  GitHubRepoService,
} from "../../../../../modules/github";

function getRepoService(): GitHubRepoService {
  const provider = new FetchGitHubProvider({
    baseUrl: env.GITHUB_API_BASE_URL,
    accessToken: env.GITHUB_ACCESS_TOKEN,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
  });
  return new GitHubRepoService(provider);
}

const associateSchema = z.object({
  owner: z.string().trim().min(1, "Repository owner is required"),
  repo: z.string().trim().min(1, "Repository name is required"),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    // 0. Enforce CSRF protection for cookie-authenticated state changes
    verifyCsrfProtection(req);

    // 1. Enforce verified server-side authentication
    const authenticatedUser = await authService.authenticateRequest(req);

    const { id: contractId } = await context.params;
    const body = (await req.json()) as unknown;
    const parsed = associateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const repoService = getRepoService();
    const repo = await repoService.associateRepository({
      contractId,
      owner: parsed.data.owner,
      repo: parsed.data.repo,
      authenticatedUser,
    });

    return NextResponse.json(
      {
        status: "success",
        repository: {
          id: repo.id,
          repoId: repo.repoId.toString(),
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          installationId: repo.installationId ? repo.installationId.toString() : null,
          isPrivate: repo.isPrivate,
          defaultBranch: repo.defaultBranch,
          htmlUrl: repo.htmlUrl,
        },
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json(
        { error: "Unauthorized", message: redactSecrets(err.message) },
        { status: 401 }
      );
    }

    if (err instanceof DomainForbiddenError) {
      return NextResponse.json(
        { error: "Forbidden", message: redactSecrets(err.message) },
        { status: 403 }
      );
    }

    if (err instanceof DomainNotFoundError) {
      return NextResponse.json(
        { error: "Not Found", message: redactSecrets(err.message) },
        { status: 404 }
      );
    }

    if (err instanceof DomainValidationError) {
      return NextResponse.json(
        { error: "Bad Request", message: redactSecrets(err.message) },
        { status: 400 }
      );
    }

    const rawMessage = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: "Internal Server Error", message: redactSecrets(rawMessage) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    // 1. Enforce verified server-side authentication
    const authenticatedUser = await authService.authenticateRequest(req);

    const { id: contractId } = await context.params;
    const repoService = getRepoService();
    const repo = await repoService.getContractRepository(contractId, authenticatedUser);

    if (!repo) {
      return NextResponse.json(
        { error: "Not Found", message: `No repository associated with contract '${contractId}'` },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        repository: {
          id: repo.id,
          repoId: repo.repoId.toString(),
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          installationId: repo.installationId ? repo.installationId.toString() : null,
          isPrivate: repo.isPrivate,
          defaultBranch: repo.defaultBranch,
          htmlUrl: repo.htmlUrl,
        },
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json(
        { error: "Unauthorized", message: redactSecrets(err.message) },
        { status: 401 }
      );
    }

    if (err instanceof DomainForbiddenError) {
      return NextResponse.json(
        { error: "Forbidden", message: redactSecrets(err.message) },
        { status: 403 }
      );
    }

    if (err instanceof DomainNotFoundError) {
      return NextResponse.json(
        { error: "Not Found", message: redactSecrets(err.message) },
        { status: 404 }
      );
    }

    const rawMessage = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: "Internal Server Error", message: redactSecrets(rawMessage) },
      { status: 500 }
    );
  }
}
