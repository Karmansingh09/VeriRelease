/**
 * VeriRelease Authentication Types
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  githubUsername?: string | null;
  isActive: boolean;
  tokenVersion: number;
}

export interface AuthTokenPayload {
  userId: string;
  tokenVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE_NAME = "vr_session";
export const OAUTH_STATE_COOKIE_NAME = "vr_oauth_state";
export const OAUTH_STATE_MAX_AGE_SECONDS = 600; // 10 minutes

export interface OAuthStatePayload {
  nonce: string;
  action: "login" | "link";
  userId?: string;
  returnTo?: string;
  createdAt: number;
}

export interface OAuthTransactionRecord {
  id: string;
  stateNonce: string;
  codeVerifier: string;
  action: "login" | "link";
  userId: string | null;
  returnTo: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface OAuthTransactionStore {
  create(
    tx: Omit<OAuthTransactionRecord, "id" | "consumedAt" | "createdAt">
  ): Promise<OAuthTransactionRecord>;
  consume(stateNonce: string, now?: Date): Promise<OAuthTransactionRecord>;
  pruneExpired(now?: Date): Promise<number>;
}

export interface GitHubOAuthUserProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl?: string | null;
}

export interface GitHubOAuthUserEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: string | null;
}
