/**
 * VeriRelease GitHub Provider Interface
 *
 * Defines the read-only external provider boundary for fetching repository metadata,
 * pull request details, commits, and check runs from GitHub.
 */

import type {
  GitHubRepoMetadata,
  GitHubPullRequestDetails,
  GitHubCommitMetadata,
  GitHubChecksSummary,
  GitHubInstallationDetails,
} from "../types";

export interface PaginationOptions {
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface GitHubProvider {
  /**
   * Resolves the authorized GitHub App installation for a repository, verifying that the App
   * is installed and has access to this repository.
   */
  getRepositoryInstallation(owner: string, repo: string): Promise<GitHubInstallationDetails>;

  /**
   * Fetches authoritative repository metadata by owner and repository name.
   */
  getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata>;

  /**
   * Fetches detailed pull request information by PR number.
   */
  getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullRequestDetails>;

  /**
   * Fetches commits belonging to a pull request with pagination safety.
   */
  getPullRequestCommits(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: PaginationOptions
  ): Promise<GitHubCommitMetadata[]>;

  /**
   * Fetches commit metadata by SHA or ref.
   */
  getCommit(owner: string, repo: string, ref: string): Promise<GitHubCommitMetadata>;

  /**
   * Fetches check runs and check suite summaries for a commit ref with pagination safety.
   */
  getPullRequestChecks(
    owner: string,
    repo: string,
    ref: string,
    options?: PaginationOptions
  ): Promise<GitHubChecksSummary>;

  /**
   * Checks the permission level of a GitHub user on a repository (e.g. 'admin', 'write', 'maintain', 'read', 'none').
   * Used to verify that the user associating the repository possesses administrative or write authorization.
   */
  getUserRepositoryPermission(
    owner: string,
    repo: string,
    username: string
  ): Promise<string>;
}
