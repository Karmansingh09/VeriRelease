/**
 * VeriRelease Prisma GitHub Repository Implementation
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient } from "../../../lib/prisma";
import type { GitHubRepository } from "../types";
import type {
  CreateGitHubRepositoryInput,
  GitHubRepositoryOptions,
  GitHubRepositoryRepository,
} from "./github-repository.interface";

export class PrismaGitHubRepository implements GitHubRepositoryRepository {
  constructor(private readonly client: DbClient = prisma) {}

  private getClient(options?: GitHubRepositoryOptions): DbClient {
    return options?.tx ?? this.client;
  }

  async upsert(
    input: CreateGitHubRepositoryInput,
    options?: GitHubRepositoryOptions
  ): Promise<GitHubRepository> {
    const db = this.getClient(options);
    const id = input.id ?? `gh_repo_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const row = await db.gitHubRepository.upsert({
      where: { repoId: input.repoId },
      create: {
        id,
        repoId: input.repoId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        installationId: input.installationId,
        isPrivate: input.isPrivate,
        defaultBranch: input.defaultBranch ?? "main",
        htmlUrl: input.htmlUrl,
        description: input.description,
      },
      update: {
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        installationId: input.installationId,
        isPrivate: input.isPrivate,
        defaultBranch: input.defaultBranch ?? "main",
        htmlUrl: input.htmlUrl,
        description: input.description,
      },
    });

    return {
      id: row.id,
      repoId: row.repoId,
      owner: row.owner,
      name: row.name,
      fullName: row.fullName,
      installationId: row.installationId,
      isPrivate: row.isPrivate,
      defaultBranch: row.defaultBranch,
      htmlUrl: row.htmlUrl,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findByRepoId(
    repoId: bigint,
    options?: GitHubRepositoryOptions
  ): Promise<GitHubRepository | null> {
    const db = this.getClient(options);
    const row = await db.gitHubRepository.findUnique({
      where: { repoId },
    });
    if (!row) return null;

    return {
      id: row.id,
      repoId: row.repoId,
      owner: row.owner,
      name: row.name,
      fullName: row.fullName,
      installationId: row.installationId,
      isPrivate: row.isPrivate,
      defaultBranch: row.defaultBranch,
      htmlUrl: row.htmlUrl,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findById(
    id: string,
    options?: GitHubRepositoryOptions
  ): Promise<GitHubRepository | null> {
    const db = this.getClient(options);
    const row = await db.gitHubRepository.findUnique({
      where: { id },
    });
    if (!row) return null;

    return {
      id: row.id,
      repoId: row.repoId,
      owner: row.owner,
      name: row.name,
      fullName: row.fullName,
      installationId: row.installationId,
      isPrivate: row.isPrivate,
      defaultBranch: row.defaultBranch,
      htmlUrl: row.htmlUrl,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async associateWithContract(
    contractId: string,
    repoId: bigint,
    owner: string,
    name: string,
    options?: GitHubRepositoryOptions
  ): Promise<void> {
    const db = this.getClient(options);
    await db.contract.update({
      where: { id: contractId },
      data: {
        githubRepoId: repoId,
        githubRepoOwner: owner,
        githubRepoName: name,
      },
    });
  }
}
