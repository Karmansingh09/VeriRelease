/**
 * VeriRelease GitHub Repository Database Interface
 *
 * Defines persistence boundary for authorized GitHub repositories
 * and contract-repository associations.
 */

import type { PrismaTransactionClient } from "../../../lib/prisma";
import type { GitHubRepository } from "../types";

export interface CreateGitHubRepositoryInput {
  id?: string;
  repoId: bigint;
  owner: string;
  name: string;
  fullName: string;
  installationId?: bigint | null;
  isPrivate: boolean;
  defaultBranch?: string;
  htmlUrl: string;
  description?: string | null;
}

export interface GitHubRepositoryOptions {
  tx?: PrismaTransactionClient;
}

export interface GitHubRepositoryRepository {
  /**
   * Upserts a GitHub repository record by its unique numeric repoId.
   */
  upsert(
    input: CreateGitHubRepositoryInput,
    options?: GitHubRepositoryOptions
  ): Promise<GitHubRepository>;

  /**
   * Finds a repository by its numeric GitHub repoId.
   */
  findByRepoId(
    repoId: bigint,
    options?: GitHubRepositoryOptions
  ): Promise<GitHubRepository | null>;

  /**
   * Finds a repository by primary string ID.
   */
  findById(
    id: string,
    options?: GitHubRepositoryOptions
  ): Promise<GitHubRepository | null>;

  /**
   * Associates an authorized GitHub repository with a Contract.
   */
  associateWithContract(
    contractId: string,
    repoId: bigint,
    owner: string,
    name: string,
    options?: GitHubRepositoryOptions
  ): Promise<void>;
}
