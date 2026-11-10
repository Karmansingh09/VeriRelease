/**
 * VeriRelease GitHub Evidence Ingestion Service
 *
 * Fetches authoritative pull request, commit, and CI check evidence from GitHub,
 * enforces cross-repository and cross-milestone isolation, computes canonical RFC 8785
 * evidence hashes covering every snapshot field, and commits immutable versioned snapshots
 * under parent milestone submission row locks.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../../lib/prisma";
import { hashCanonicalJson } from "../../common/canonical-json";
import {
  ConcurrencyConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
} from "../../common/errors";
import type { AuditService } from "../../audit/audit-service.interface";
import { TransactionalAuditService } from "../../audit/audit-service";
import type { AuthenticatedUser } from "../../auth/types";
import type { GitHubProvider } from "../provider/github-provider.interface";
import type { GitHubEvidenceSnapshot } from "../types";
import type { EvidenceSnapshotRepository } from "./evidence-snapshot.interface";
import { PrismaEvidenceRepository } from "./prisma-evidence-repository";

export interface CollectSubmissionEvidenceInput {
  submissionId: string;
  milestoneId: string;
  authenticatedUser: AuthenticatedUser;
  correlationId?: string;
}

export interface GitHubEvidenceServiceOptions {
  tx?: PrismaTransactionClient;
}

export class GitHubEvidenceService {
  constructor(
    private readonly githubProvider: GitHubProvider,
    private readonly evidenceRepo: EvidenceSnapshotRepository = new PrismaEvidenceRepository(prisma),
    private readonly auditService: AuditService = new TransactionalAuditService(undefined, prisma),
    private readonly client: DbClient = prisma
  ) {}

  /**
   * Collects and binds immutable GitHub evidence to an existing milestone submission.
   *
   * Security Invariants Enforced:
   * 1. Authorization: caller must be contract client, developer, submission author, or ADMIN.
   * 2. Milestone and Submission Consistency: submission must belong to the specified milestoneId.
   * 3. Repository Authorization: Contract must be linked to an authorized GitHub repository.
   * 4. Strict Cross-Repository Isolation: The PR's target repository ID (baseRepoId) must exist
   *    and match the contract's authorized repository ID.
   * 5. Commit SHA Integrity: The PR's head commit SHA must match the submission's prCommitSha.
   * 6. Concurrency & Locking: Acquires row-level lock on MilestoneSubmission (FOR UPDATE)
   *    to serialize snapshotVersion allocation.
   * 7. Cryptographic Integrity: Complete RFC 8785 canonical JSON SHA-256 evidenceHash covering all
   *    check runs, conclusions, commits, dates, and identities.
   */
  async collectSubmissionEvidence(
    input: CollectSubmissionEvidenceInput,
    options?: GitHubEvidenceServiceOptions
  ): Promise<GitHubEvidenceSnapshot> {
    const { authenticatedUser } = input;
    if (!authenticatedUser || !authenticatedUser.id) {
      throw new DomainForbiddenError("Valid authenticated user context is required");
    }

    const correlationId =
      input.correlationId ?? `ev_corr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // 1. Audit start of evidence collection
    await this.auditService.recordEvent({
      entityType: "SUBMISSION",
      entityId: input.submissionId,
      actorType: "USER",
      actorUserId: authenticatedUser.id,
      action: "EVIDENCE_COLLECTION_STARTED",
      metadata: {
        milestoneId: input.milestoneId,
        submissionId: input.submissionId,
      },
      correlationId,
    });

    try {
      // 2. Query submission, milestone, contract, and authorized repo
      const submission = await (options?.tx ?? this.client).milestoneSubmission.findUnique({
        where: { id: input.submissionId },
        include: {
          milestone: {
            include: {
              contract: true,
            },
          },
        },
      });

      if (!submission) {
        throw new DomainNotFoundError("MilestoneSubmission", input.submissionId);
      }

      if (submission.milestoneId !== input.milestoneId) {
        throw new DomainValidationError(
          `Submission '${input.submissionId}' belongs to milestone '${submission.milestoneId}', not '${input.milestoneId}'`
        );
      }

      const contract = submission.milestone.contract;

      // Authorization Check
      const isAuthorizedParty =
        contract.clientId === authenticatedUser.id ||
        contract.developerId === authenticatedUser.id ||
        submission.submittedById === authenticatedUser.id ||
        authenticatedUser.role === "ADMIN";

      if (!isAuthorizedParty) {
        throw new DomainForbiddenError(
          `User '${authenticatedUser.id}' is not authorized to trigger evidence collection for submission '${input.submissionId}'`
        );
      }

      if (!contract.githubRepoId) {
        throw new DomainValidationError(
          `Contract '${contract.id}' has no authorized GitHub repository associated. Repository must be linked before evidence can be collected.`
        );
      }

      const repoOwner = contract.githubRepoOwner;
      const repoName = contract.githubRepoName;
      const expectedRepoId = contract.githubRepoId;

      // 3. Retrieve PR details from GitHub via provider
      const prDetails = await this.githubProvider.getPullRequest(
        repoOwner,
        repoName,
        submission.prNumber
      );

      // 4. Strict Cross-repository isolation check: baseRepoId must be present and match expected repoId
      if (!prDetails.baseRepoId) {
        throw new DomainValidationError(
          `Cross-repository isolation violation: PR #${submission.prNumber} target repository ID is missing from GitHub provider response`
        );
      }

      if (BigInt(prDetails.baseRepoId) !== expectedRepoId) {
        throw new DomainValidationError(
          `Cross-repository isolation violation: PR #${submission.prNumber} target repo ID (${prDetails.baseRepoId}) does not match authorized contract repo ID (${expectedRepoId})`
        );
      }

      // 5. Commit SHA integrity check
      const normalizedSubmissionSha = submission.prCommitSha.toLowerCase();
      const normalizedPrHeadSha = prDetails.headSha.toLowerCase();
      if (normalizedPrHeadSha !== normalizedSubmissionSha) {
        throw new DomainValidationError(
          `Pull request #${submission.prNumber} head commit SHA '${normalizedPrHeadSha}' does not match submission commit SHA '${normalizedSubmissionSha}'`
        );
      }

      // 6. Fetch commits and checks via provider
      const commits = await this.githubProvider.getPullRequestCommits(
        repoOwner,
        repoName,
        submission.prNumber
      );

      const checks = await this.githubProvider.getPullRequestChecks(
        repoOwner,
        repoName,
        normalizedSubmissionSha
      );

      const collectedAt = new Date();

      // 7. Construct complete canonical payload for RFC 8785 hashing
      const canonicalPayload = {
        apiVersion: "2022-11-28",
        baseBranch: prDetails.baseRef,
        baseCommitSha: prDetails.baseSha,
        checks: {
          checkRuns: checks.checkRuns.map((cr) => ({
            completedAt: cr.completedAt ? cr.completedAt.toISOString() : null,
            conclusion: cr.conclusion,
            detailsUrl: cr.detailsUrl,
            id: cr.id,
            name: cr.name,
            startedAt: cr.startedAt ? cr.startedAt.toISOString() : null,
            status: cr.status,
          })),
          status: checks.status,
          totalCount: checks.totalCount,
        },
        checksStatus: checks.status,
        collectedAt: collectedAt.toISOString(),
        commitCount: commits.length,
        commits: commits.map((c) => ({
          authorEmail: c.authorEmail,
          authorName: c.authorName,
          authoredDate: c.authoredDate.toISOString(),
          committedDate: c.committedDate.toISOString(),
          committerEmail: c.committerEmail,
          committerName: c.committerName,
          message: c.message,
          parents: c.parents,
          sha: c.sha,
          treeSha: c.treeSha,
        })),
        headBranch: prDetails.headRef,
        headCommitSha: prDetails.headSha,
        isMerged: prDetails.isMerged,
        mergeCommitSha: prDetails.mergeCommitSha,
        mergedAt: prDetails.mergedAt ? prDetails.mergedAt.toISOString() : null,
        milestoneId: input.milestoneId,
        prAuthor: prDetails.authorUsername,
        prAuthorId: prDetails.authorId,
        prId: prDetails.id,
        prNumber: prDetails.number,
        prState: prDetails.state,
        prTitle: prDetails.title,
        prUrl: prDetails.htmlUrl,
        provider: "github",
        repoName,
        repoOwner,
        repositoryId: expectedRepoId.toString(),
        submissionId: input.submissionId,
      };

      const evidenceHash = hashCanonicalJson(canonicalPayload);

      // 8. Persist evidence snapshot and record audit in transaction under row lock
      const runInTx = async (tx: PrismaTransactionClient): Promise<GitHubEvidenceSnapshot> => {
        // Lock parent MilestoneSubmission row to serialize snapshot version allocation
        await tx.$queryRaw`
          SELECT id FROM "MilestoneSubmission"
          WHERE id = ${submission.id}
          FOR UPDATE;
        `;

        const nextVersion = await this.evidenceRepo.getNextSnapshotVersion(
          submission.id,
          { tx }
        );

        let snapshot: GitHubEvidenceSnapshot;
        try {
          snapshot = await this.evidenceRepo.create(
            {
              submissionId: submission.id,
              milestoneId: submission.milestoneId,
              snapshotVersion: nextVersion,
              repositoryId: expectedRepoId,
              repoOwner,
              repoName,
              prNumber: prDetails.number,
              prId: BigInt(prDetails.id),
              prUrl: prDetails.htmlUrl,
              prTitle: prDetails.title,
              prBody: prDetails.body,
              prAuthor: prDetails.authorUsername,
              prAuthorId: BigInt(prDetails.authorId),
              prState: prDetails.state,
              isMerged: prDetails.isMerged,
              mergedAt: prDetails.mergedAt,
              mergeCommitSha: prDetails.mergeCommitSha,
              headBranch: prDetails.headRef,
              headCommitSha: prDetails.headSha,
              baseBranch: prDetails.baseRef,
              baseCommitSha: prDetails.baseSha,
              commitCount: commits.length,
              commits,
              checks,
              checksStatus: checks.status,
              rawPayload: canonicalPayload,
              evidenceHash,
              collectedAt,
              provider: "github",
              apiVersion: "2022-11-28",
            },
            { tx }
          );
        } catch (createErr: unknown) {
          if (
            createErr instanceof Prisma.PrismaClientKnownRequestError &&
            createErr.code === "P2002"
          ) {
            throw new ConcurrencyConflictError(
              `Evidence snapshot version collision for submission '${submission.id}' (version ${nextVersion})`
            );
          }
          throw createErr;
        }

        await this.auditService.recordEvent(
          {
            entityType: "SUBMISSION",
            entityId: submission.id,
            actorType: "USER",
            actorUserId: authenticatedUser.id,
            action: "EVIDENCE_SNAPSHOT_CREATED",
            metadata: {
              snapshotId: snapshot.id,
              snapshotVersion: snapshot.snapshotVersion,
              evidenceHash: snapshot.evidenceHash,
              repositoryId: expectedRepoId.toString(),
              prNumber: snapshot.prNumber,
              headCommitSha: snapshot.headCommitSha,
              checksStatus: snapshot.checksStatus,
            },
            correlationId,
          },
          { tx }
        );

        return snapshot;
      };

      if (options?.tx) {
        return runInTx(options.tx);
      }
      return (this.client as PrismaClient).$transaction(runInTx);
    } catch (err) {
      // Record failure audit log
      try {
        await this.auditService.recordEvent({
          entityType: "SUBMISSION",
          entityId: input.submissionId,
          actorType: "USER",
          actorUserId: authenticatedUser.id,
          action: "EVIDENCE_COLLECTION_FAILED",
          metadata: {
            milestoneId: input.milestoneId,
            submissionId: input.submissionId,
            error: err instanceof Error ? err.message : String(err),
          },
          correlationId,
        });
      } catch {
        // Suppress secondary audit error
      }
      throw err;
    }
  }

  /**
   * Retrieves the latest evidence snapshot for a submission, enforcing caller authorization.
   */
  async getLatestEvidenceSnapshot(
    submissionId: string,
    authenticatedUser: AuthenticatedUser,
    options?: GitHubEvidenceServiceOptions
  ): Promise<GitHubEvidenceSnapshot | null> {
    const db = options?.tx ?? this.client;
    const submission = await db.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: {
        milestone: {
          include: {
            contract: true,
          },
        },
      },
    });

    if (!submission) {
      throw new DomainNotFoundError("MilestoneSubmission", submissionId);
    }

    const contract = submission.milestone.contract;
    const isAuthorized =
      contract.clientId === authenticatedUser.id ||
      contract.developerId === authenticatedUser.id ||
      submission.submittedById === authenticatedUser.id ||
      authenticatedUser.role === "ADMIN";

    if (!isAuthorized) {
      throw new DomainForbiddenError(
        `User '${authenticatedUser.id}' is not authorized to view evidence for submission '${submissionId}'`
      );
    }

    return this.evidenceRepo.findLatestBySubmissionId(submissionId, options);
  }

  /**
   * Retrieves a specific version of an evidence snapshot for a submission, enforcing caller authorization.
   */
  async getEvidenceSnapshotByVersion(
    submissionId: string,
    version: number,
    authenticatedUser: AuthenticatedUser,
    options?: GitHubEvidenceServiceOptions
  ): Promise<GitHubEvidenceSnapshot | null> {
    const db = options?.tx ?? this.client;
    const submission = await db.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: {
        milestone: {
          include: {
            contract: true,
          },
        },
      },
    });

    if (!submission) {
      throw new DomainNotFoundError("MilestoneSubmission", submissionId);
    }

    const contract = submission.milestone.contract;
    const isAuthorized =
      contract.clientId === authenticatedUser.id ||
      contract.developerId === authenticatedUser.id ||
      submission.submittedById === authenticatedUser.id ||
      authenticatedUser.role === "ADMIN";

    if (!isAuthorized) {
      throw new DomainForbiddenError(
        `User '${authenticatedUser.id}' is not authorized to view evidence for submission '${submissionId}'`
      );
    }

    return this.evidenceRepo.findBySubmissionAndVersion(submissionId, version, options);
  }
}
