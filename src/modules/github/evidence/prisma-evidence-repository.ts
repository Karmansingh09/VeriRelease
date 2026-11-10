/**
 * VeriRelease Prisma GitHub Evidence Repository Implementation
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type DbClient } from "../../../lib/prisma";
import type {
  GitHubCheckStatus,
  GitHubChecksSummary,
  GitHubCommitMetadata,
  GitHubEvidenceSnapshot,
} from "../types";
import type {
  CreateEvidenceSnapshotInput,
  EvidenceSnapshotOptions,
  EvidenceSnapshotRepository,
} from "./evidence-snapshot.interface";

export class PrismaEvidenceRepository implements EvidenceSnapshotRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: EvidenceSnapshotOptions): DbClient {
    return options?.tx ?? this.client;
  }

  private mapToDomain(row: {
    id: string;
    submissionId: string;
    milestoneId: string;
    snapshotVersion: number;
    repositoryId: bigint;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    prId: bigint | null;
    prUrl: string;
    prTitle: string;
    prBody: string | null;
    prAuthor: string;
    prAuthorId: bigint | null;
    prState: string;
    isMerged: boolean;
    mergedAt: Date | null;
    mergeCommitSha: string | null;
    headBranch: string;
    headCommitSha: string;
    baseBranch: string;
    baseCommitSha: string;
    commitCount: number;
    commits: Prisma.JsonValue;
    checks: Prisma.JsonValue;
    checksStatus: string;
    rawPayload: Prisma.JsonValue | null;
    evidenceHash: string;
    collectedAt: Date;
    provider: string;
    apiVersion: string;
  }): GitHubEvidenceSnapshot {
    return {
      id: row.id,
      submissionId: row.submissionId,
      milestoneId: row.milestoneId,
      snapshotVersion: row.snapshotVersion,
      repositoryId: row.repositoryId,
      repoOwner: row.repoOwner,
      repoName: row.repoName,
      prNumber: row.prNumber,
      prId: row.prId,
      prUrl: row.prUrl,
      prTitle: row.prTitle,
      prBody: row.prBody,
      prAuthor: row.prAuthor,
      prAuthorId: row.prAuthorId,
      prState: row.prState,
      isMerged: row.isMerged,
      mergedAt: row.mergedAt,
      mergeCommitSha: row.mergeCommitSha,
      headBranch: row.headBranch,
      headCommitSha: row.headCommitSha,
      baseBranch: row.baseBranch,
      baseCommitSha: row.baseCommitSha,
      commitCount: row.commitCount,
      commits: row.commits as unknown as GitHubCommitMetadata[],
      checks: row.checks as unknown as GitHubChecksSummary,
      checksStatus: row.checksStatus as GitHubCheckStatus,
      rawPayload: row.rawPayload as Record<string, unknown> | null,
      evidenceHash: row.evidenceHash,
      collectedAt: row.collectedAt,
      provider: row.provider,
      apiVersion: row.apiVersion,
    };
  }

  async create(
    input: CreateEvidenceSnapshotInput,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot> {
    const db = this.getClient(options);
    const id = input.id ?? `evs_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const row = await db.gitHubEvidenceSnapshot.create({
      data: {
        id,
        submissionId: input.submissionId,
        milestoneId: input.milestoneId,
        snapshotVersion: input.snapshotVersion,
        repositoryId: input.repositoryId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prId: input.prId,
        prUrl: input.prUrl,
        prTitle: input.prTitle,
        prBody: input.prBody,
        prAuthor: input.prAuthor,
        prAuthorId: input.prAuthorId,
        prState: input.prState,
        isMerged: input.isMerged,
        mergedAt: input.mergedAt,
        mergeCommitSha: input.mergeCommitSha,
        headBranch: input.headBranch,
        headCommitSha: input.headCommitSha,
        baseBranch: input.baseBranch,
        baseCommitSha: input.baseCommitSha,
        commitCount: input.commitCount,
        commits: input.commits as unknown as Prisma.InputJsonValue,
        checks: input.checks as unknown as Prisma.InputJsonValue,
        checksStatus: input.checksStatus,
        rawPayload: input.rawPayload as Prisma.InputJsonValue,
        evidenceHash: input.evidenceHash,
        collectedAt: input.collectedAt ?? new Date(),
        provider: input.provider ?? "github",
        apiVersion: input.apiVersion ?? "2022-11-28",
      },
    });

    return this.mapToDomain(row);
  }

  async findLatestBySubmissionId(
    submissionId: string,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot | null> {
    const db = this.getClient(options);
    const row = await db.gitHubEvidenceSnapshot.findFirst({
      where: { submissionId },
      orderBy: { snapshotVersion: "desc" },
    });
    if (!row) return null;
    return this.mapToDomain(row);
  }

  async findBySubmissionAndVersion(
    submissionId: string,
    snapshotVersion: number,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot | null> {
    const db = this.getClient(options);
    const row = await db.gitHubEvidenceSnapshot.findUnique({
      where: {
        submissionId_snapshotVersion: {
          submissionId,
          snapshotVersion,
        },
      },
    });
    if (!row) return null;
    return this.mapToDomain(row);
  }

  async findById(
    id: string,
    options?: EvidenceSnapshotOptions
  ): Promise<GitHubEvidenceSnapshot | null> {
    const db = this.getClient(options);
    const row = await db.gitHubEvidenceSnapshot.findUnique({
      where: { id },
    });
    if (!row) return null;
    return this.mapToDomain(row);
  }

  async getNextSnapshotVersion(
    submissionId: string,
    options?: EvidenceSnapshotOptions
  ): Promise<number> {
    const db = this.getClient(options);
    const rows = await db.$queryRaw<Array<{ nextVersion: number }>>`
      SELECT COALESCE(MAX("snapshotVersion"), 0) + 1 AS "nextVersion"
      FROM "GitHubEvidenceSnapshot"
      WHERE "submissionId" = ${submissionId};
    `;
    return rows[0]?.nextVersion ?? 1;
  }
}
