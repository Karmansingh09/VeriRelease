/**
 * VeriRelease Mock GitHub Provider
 *
 * Configurable, deterministic in-memory provider for unit and integration testing.
 * Permits configuring repositories, installations, pull requests, commits, and checks without external network access.
 */

import {
  DomainForbiddenError,
  DomainNotFoundError,
  GitHubRateLimitError,
  ProviderUnavailableError,
} from "../../common/errors";
import type {
  GitHubChecksSummary,
  GitHubCommitMetadata,
  GitHubPullRequestDetails,
  GitHubRepoMetadata,
  GitHubInstallationDetails,
} from "../types";
import type { GitHubProvider, PaginationOptions } from "./github-provider.interface";

export class MockGitHubProvider implements GitHubProvider {
  public installations: Map<string, GitHubInstallationDetails> = new Map();
  public repositories: Map<string, GitHubRepoMetadata> = new Map();
  public pullRequests: Map<string, GitHubPullRequestDetails> = new Map();
  public pullRequestCommits: Map<string, GitHubCommitMetadata[]> = new Map();
  public commits: Map<string, GitHubCommitMetadata> = new Map();
  public checks: Map<string, GitHubChecksSummary> = new Map();
  public userPermissions: Map<string, string> = new Map();

  public simulateRateLimit: boolean = false;
  public simulateTimeout: boolean = false;
  public simulateNetworkFailure: boolean = false;

  private makeRepoKey(owner: string, repo: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  private makePRKey(owner: string, repo: string, pullNumber: number): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${pullNumber}`;
  }

  private makeCommitKey(owner: string, repo: string, ref: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref.toLowerCase()}`;
  }

  async getRepositoryInstallation(owner: string, repo: string): Promise<GitHubInstallationDetails> {
    if (this.simulateTimeout) {
      throw new ProviderUnavailableError("GitHub", "Request timed out", 408);
    }
    const key = this.makeRepoKey(owner, repo);
    const found = this.installations.get(key);
    if (!found) {
      throw new DomainForbiddenError(
        `GitHub App is not installed on repository '${owner}/${repo}' or installation was revoked`
      );
    }
    return found;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata> {
    if (this.simulateTimeout) {
      throw new ProviderUnavailableError("GitHub", "Request timed out", 408);
    }
    if (this.simulateRateLimit) {
      throw new GitHubRateLimitError("Rate limit exceeded", new Date(Date.now() + 3600_000), 60);
    }
    if (this.simulateNetworkFailure) {
      throw new ProviderUnavailableError("GitHub", "Network unreachable");
    }

    const key = this.makeRepoKey(owner, repo);
    const found = this.repositories.get(key);
    if (!found) {
      throw new DomainNotFoundError("GitHub Repository", `${owner}/${repo}`);
    }
    return found;
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullRequestDetails> {
    if (this.simulateTimeout) {
      throw new ProviderUnavailableError("GitHub", "Request timed out", 408);
    }
    if (this.simulateRateLimit) {
      throw new GitHubRateLimitError("Rate limit exceeded", new Date(Date.now() + 3600_000), 60);
    }

    const key = this.makePRKey(owner, repo, pullNumber);
    const found = this.pullRequests.get(key);
    if (!found) {
      throw new DomainNotFoundError("GitHub Pull Request", `${owner}/${repo}#${pullNumber}`);
    }
    return found;
  }

  async getPullRequestCommits(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: PaginationOptions
  ): Promise<GitHubCommitMetadata[]> {
    if (this.simulateTimeout) {
      throw new ProviderUnavailableError("GitHub", "Request timed out", 408);
    }

    const key = this.makePRKey(owner, repo, pullNumber);
    const commits = this.pullRequestCommits.get(key) ?? [];

    const page = options?.page ?? 1;
    const perPage = options?.perPage ?? 100;
    const startIndex = (page - 1) * perPage;
    return commits.slice(startIndex, startIndex + perPage);
  }

  async getCommit(owner: string, repo: string, ref: string): Promise<GitHubCommitMetadata> {
    if (this.simulateTimeout) {
      throw new ProviderUnavailableError("GitHub", "Request timed out", 408);
    }

    const key = this.makeCommitKey(owner, repo, ref);
    const found = this.commits.get(key);
    if (!found) {
      throw new DomainNotFoundError("GitHub Commit", `${owner}/${repo}@${ref}`);
    }
    return found;
  }

  async getPullRequestChecks(
    owner: string,
    repo: string,
    ref: string,
    options?: PaginationOptions
  ): Promise<GitHubChecksSummary> {
    if (this.simulateTimeout) {
      throw new ProviderUnavailableError("GitHub", "Request timed out", 408);
    }

    const key = this.makeCommitKey(owner, repo, ref);
    const found = this.checks.get(key);
    if (!found) {
      return {
        status: "UNAVAILABLE",
        totalCount: 0,
        checkRuns: [],
      };
    }

    if (!options?.page && !options?.perPage) {
      return found;
    }

    const page = options.page ?? 1;
    const perPage = options.perPage ?? 100;
    const startIndex = (page - 1) * perPage;
    const pageRuns = found.checkRuns.slice(startIndex, startIndex + perPage);

    return {
      status: found.status,
      totalCount: found.totalCount,
      checkRuns: pageRuns,
    };
  }

  async getUserRepositoryPermission(
    owner: string,
    repo: string,
    username: string
  ): Promise<string> {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}:${username.toLowerCase()}`;
    return this.userPermissions.get(key) ?? "admin";
  }
}
