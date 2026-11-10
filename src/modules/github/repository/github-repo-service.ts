/**
 * VeriRelease GitHub Repository Service
 *
 * Coordinates repository validation, authorization checks, and persistence.
 * Prevents unauthorized users from associating arbitrary repositories with contracts.
 */

import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient, type PrismaTransactionClient } from "../../../lib/prisma";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
} from "../../common/errors";
import type { AuditService } from "../../audit/audit-service.interface";
import { TransactionalAuditService } from "../../audit/audit-service";
import type { AuthenticatedUser } from "../../auth/types";
import type { GitHubProvider } from "../provider/github-provider.interface";
import type { GitHubRepository } from "../types";
import type { GitHubRepositoryRepository } from "./github-repository.interface";
import { PrismaGitHubRepository } from "./prisma-github-repository";

export interface AssociateRepositoryInput {
  contractId: string;
  owner: string;
  repo: string;
  authenticatedUser: AuthenticatedUser;
  correlationId?: string;
}

export interface GitHubRepoServiceOptions {
  tx?: PrismaTransactionClient;
}

export class GitHubRepoService {
  constructor(
    private readonly githubProvider: GitHubProvider,
    private readonly repoRepository: GitHubRepositoryRepository = new PrismaGitHubRepository(prisma),
    private readonly auditService: AuditService = new TransactionalAuditService(undefined, prisma),
    private readonly client: DbClient = prisma
  ) {}

  /**
   * Associates an authorized GitHub repository with a contract.
   *
   * Security & Authorization Guarantees:
   * 1. Validates that the caller is an authenticated party to the contract (clientId, developerId, or ADMIN).
   * 2. Authoritative repository identity (repoId, defaultBranch, isPrivate) is fetched directly
   *    from GitHub via the provider; client assertions of repoId are never trusted.
   * 3. Verifies that the repository belongs to an authorized GitHub App installation (not merely public).
   * 4. Atomically upserts the repository and updates the contract within a transaction.
   * 5. Emits an immutable audit log of the association.
   */
  async associateRepository(
    input: AssociateRepositoryInput,
    options?: GitHubRepoServiceOptions
  ): Promise<GitHubRepository> {
    const owner = input.owner.trim();
    const repo = input.repo.trim();

    if (!owner || !repo) {
      throw new DomainValidationError("GitHub repository owner and name must not be empty");
    }

    const { authenticatedUser } = input;
    if (!authenticatedUser || !authenticatedUser.id) {
      throw new DomainForbiddenError("Valid authenticated user context is required");
    }

    const runInTx = async (tx: PrismaTransactionClient): Promise<GitHubRepository> => {
      // 1. Fetch contract and verify existence
      const contract = await tx.contract.findUnique({
        where: { id: input.contractId },
      });

      if (!contract) {
        throw new DomainNotFoundError("Contract", input.contractId);
      }

      // 2. Authorization check A: caller must be contract client, developer, or ADMIN
      const isAuthorizedParty =
        contract.clientId === authenticatedUser.id ||
        contract.developerId === authenticatedUser.id ||
        authenticatedUser.role === "ADMIN";

      if (!isAuthorizedParty) {
        throw new DomainForbiddenError(
          `User '${authenticatedUser.id}' is not authorized to associate a repository with contract '${input.contractId}'`
        );
      }

      // 2b. Authorization check B: caller must possess verified administrative or write permission on GitHub repository
      let callerPermission = "ADMIN";
      if (authenticatedUser.role !== "ADMIN") {
        if (!authenticatedUser.githubUsername || authenticatedUser.githubUsername.trim() === "") {
          throw new DomainForbiddenError(
            `User '${authenticatedUser.id}' must have a linked githubUsername to authorize GitHub repository integration`
          );
        }

        callerPermission = await this.githubProvider.getUserRepositoryPermission(
          owner,
          repo,
          authenticatedUser.githubUsername.trim()
        );

        const allowedPermissions = ["admin", "write", "maintain"];
        if (!allowedPermissions.includes(callerPermission.toLowerCase())) {
          throw new DomainForbiddenError(
            `GitHub repository authorization failure: User '${authenticatedUser.githubUsername}' lacks administrative or write permissions on repository '${owner}/${repo}' (detected permission: '${callerPermission}')`
          );
        }
      }

      // 3. Verify that repository belongs to an authorized GitHub App installation
      const installation = await this.githubProvider.getRepositoryInstallation(owner, repo);

      // 4. Query authoritative repository metadata via GitHub provider
      const repoMeta = await this.githubProvider.getRepository(owner, repo);

      // 5. Upsert GitHubRepository record
      const persistedRepo = await this.repoRepository.upsert(
        {
          repoId: BigInt(repoMeta.id),
          owner: repoMeta.owner,
          name: repoMeta.name,
          fullName: repoMeta.fullName,
          installationId: BigInt(installation.id),
          isPrivate: repoMeta.isPrivate,
          defaultBranch: repoMeta.defaultBranch,
          htmlUrl: repoMeta.htmlUrl,
          description: repoMeta.description,
        },
        { tx }
      );

      // 6. Update Contract association
      await this.repoRepository.associateWithContract(
        contract.id,
        persistedRepo.repoId,
        persistedRepo.owner,
        persistedRepo.name,
        { tx }
      );

      // 7. Record audit log
      const correlationId = input.correlationId ?? `corr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      await this.auditService.recordEvent(
        {
          entityType: "CONTRACT",
          entityId: contract.id,
          actorType: "USER",
          actorUserId: authenticatedUser.id,
          action: "REPOSITORY_ASSOCIATED",
          previousState: {
            githubRepoId: contract.githubRepoId ? contract.githubRepoId.toString() : null,
            githubRepoOwner: contract.githubRepoOwner,
            githubRepoName: contract.githubRepoName,
          },
          newState: {
            githubRepoId: persistedRepo.repoId.toString(),
            githubRepoOwner: persistedRepo.owner,
            githubRepoName: persistedRepo.name,
          },
          metadata: {
            repoId: persistedRepo.repoId.toString(),
            repoFullName: persistedRepo.fullName,
            installationId: installation.id.toString(),
            isPrivate: persistedRepo.isPrivate,
            associatedByUserId: authenticatedUser.id,
            associatedByGithubUsername: authenticatedUser.githubUsername ?? null,
            githubPermission: callerPermission,
          },
          correlationId,
        },
        { tx }
      );

      return persistedRepo;
    };

    if (options?.tx) {
      return runInTx(options.tx);
    }
    return (this.client as PrismaClient).$transaction(runInTx);
  }

  /**
   * Retrieves the associated repository for a contract, enforcing authorization.
   */
  async getContractRepository(
    contractId: string,
    authenticatedUser: AuthenticatedUser,
    options?: GitHubRepoServiceOptions
  ): Promise<GitHubRepository | null> {
    const db = options?.tx ?? this.client;
    const contract = await db.contract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      throw new DomainNotFoundError("Contract", contractId);
    }

    // Authorization check
    const isAuthorizedParty =
      contract.clientId === authenticatedUser.id ||
      contract.developerId === authenticatedUser.id ||
      authenticatedUser.role === "ADMIN";

    if (!isAuthorizedParty) {
      throw new DomainForbiddenError(
        `User '${authenticatedUser.id}' is not authorized to view repository for contract '${contractId}'`
      );
    }

    if (!contract.githubRepoId) {
      return null;
    }

    return this.repoRepository.findByRepoId(contract.githubRepoId, options);
  }
}
