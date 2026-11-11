/**
 * Submission Evidence API Route
 *
 * Endpoint:
 *   POST /api/submissions/[id]/evidence - Requests evidence collection for an authorized submission
 *   GET  /api/submissions/[id]/evidence - Retrieves the latest or versioned evidence snapshot
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "../../../../../lib/env";
import { authService } from "../../../../../modules/auth";
import {
  ConcurrencyConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../../../../modules/common/errors";
import { verifyCsrfProtection } from "../../../../../modules/common/csrf";
import { redactSecrets } from "../../../../../modules/common/redact";
import {
  FetchGitHubProvider,
  GitHubEvidenceService,
} from "../../../../../modules/github";

function getEvidenceService(): GitHubEvidenceService {
  const provider = new FetchGitHubProvider({
    baseUrl: env.GITHUB_API_BASE_URL,
    accessToken: env.GITHUB_ACCESS_TOKEN,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
  });
  return new GitHubEvidenceService(provider);
}

const collectEvidenceSchema = z.object({
  milestoneId: z.string().trim().min(1, "milestoneId is required"),
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

    const { id: submissionId } = await context.params;
    const body = (await req.json()) as unknown;
    const parsed = collectEvidenceSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation Error", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const evidenceService = getEvidenceService();
    const snapshot = await evidenceService.collectSubmissionEvidence({
      submissionId,
      milestoneId: parsed.data.milestoneId,
      authenticatedUser,
    });

    return NextResponse.json(
      {
        status: "success",
        evidenceSnapshot: {
          id: snapshot.id,
          submissionId: snapshot.submissionId,
          milestoneId: snapshot.milestoneId,
          snapshotVersion: snapshot.snapshotVersion,
          repositoryId: snapshot.repositoryId.toString(),
          repoOwner: snapshot.repoOwner,
          repoName: snapshot.repoName,
          prNumber: snapshot.prNumber,
          prUrl: snapshot.prUrl,
          prTitle: snapshot.prTitle,
          prState: snapshot.prState,
          isMerged: snapshot.isMerged,
          mergedAt: snapshot.mergedAt,
          mergeCommitSha: snapshot.mergeCommitSha,
          headBranch: snapshot.headBranch,
          headCommitSha: snapshot.headCommitSha,
          baseBranch: snapshot.baseBranch,
          baseCommitSha: snapshot.baseCommitSha,
          commitCount: snapshot.commitCount,
          commits: snapshot.commits,
          checks: snapshot.checks,
          checksStatus: snapshot.checksStatus,
          evidenceHash: snapshot.evidenceHash,
          collectedAt: snapshot.collectedAt,
          provider: snapshot.provider,
          apiVersion: snapshot.apiVersion,
        },
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json(
        { error: "Unauthorized", message: "GitHub authentication needs to be refreshed." },
        { status: 401 }
      );
    }

    if (err instanceof DomainForbiddenError) {
      return NextResponse.json(
        { error: "Forbidden", message: "GitHub access permission is insufficient." },
        { status: 403 }
      );
    }

    if (err instanceof DomainNotFoundError) {
      const message =
        err.entity === "MilestoneSubmission"
          ? redactSecrets(err.message)
          : "Pull request not found or inaccessible.";
      return NextResponse.json(
        { error: "Not Found", message },
        { status: 404 }
      );
    }

    if (err instanceof DomainValidationError) {
      return NextResponse.json(
        { error: "Bad Request", message: redactSecrets(err.message) },
        { status: 400 }
      );
    }

    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json(
        { error: "Conflict", message: redactSecrets(err.message) },
        { status: 409 }
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

    const { id: submissionId } = await context.params;
    const { searchParams } = new URL(req.url);
    const versionParam = searchParams.get("version");

    const evidenceService = getEvidenceService();
    let snapshot = null;
    if (versionParam) {
      const versionNumber = parseInt(versionParam, 10);
      if (isNaN(versionNumber) || versionNumber < 1) {
        return NextResponse.json(
          { error: "Bad Request", message: "Invalid version parameter" },
          { status: 400 }
        );
      }
      snapshot = await evidenceService.getEvidenceSnapshotByVersion(
        submissionId,
        versionNumber,
        authenticatedUser
      );
    } else {
      snapshot = await evidenceService.getLatestEvidenceSnapshot(submissionId, authenticatedUser);
    }

    if (!snapshot) {
      return NextResponse.json(
        { error: "Not Found", message: `No evidence snapshot found for submission '${submissionId}'` },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        evidenceSnapshot: {
          id: snapshot.id,
          submissionId: snapshot.submissionId,
          milestoneId: snapshot.milestoneId,
          snapshotVersion: snapshot.snapshotVersion,
          repositoryId: snapshot.repositoryId.toString(),
          repoOwner: snapshot.repoOwner,
          repoName: snapshot.repoName,
          prNumber: snapshot.prNumber,
          prUrl: snapshot.prUrl,
          prTitle: snapshot.prTitle,
          prState: snapshot.prState,
          isMerged: snapshot.isMerged,
          mergedAt: snapshot.mergedAt,
          mergeCommitSha: snapshot.mergeCommitSha,
          headBranch: snapshot.headBranch,
          headCommitSha: snapshot.headCommitSha,
          baseBranch: snapshot.baseBranch,
          baseCommitSha: snapshot.baseCommitSha,
          commitCount: snapshot.commitCount,
          commits: snapshot.commits,
          checks: snapshot.checks,
          checksStatus: snapshot.checksStatus,
          evidenceHash: snapshot.evidenceHash,
          collectedAt: snapshot.collectedAt,
          provider: snapshot.provider,
          apiVersion: snapshot.apiVersion,
        },
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    if (err instanceof DomainUnauthorizedError) {
      return NextResponse.json(
        { error: "Unauthorized", message: "GitHub authentication needs to be refreshed." },
        { status: 401 }
      );
    }

    if (err instanceof DomainForbiddenError) {
      return NextResponse.json(
        { error: "Forbidden", message: "GitHub access permission is insufficient." },
        { status: 403 }
      );
    }

    if (err instanceof DomainNotFoundError) {
      const message =
        err.entity === "MilestoneSubmission"
          ? redactSecrets(err.message)
          : "Pull request not found or inaccessible.";
      return NextResponse.json(
        { error: "Not Found", message },
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
