/**
 * VeriRelease Server-Side Authentication Service
 *
 * Implements cryptographic bearer token generation, constant-time verification,
 * token versioning / revocation, and authoritative database user identity & status resolution.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma, type DbClient, type PrismaTransactionClient } from "../../lib/prisma";
import { env } from "../../lib/env";
import { DomainUnauthorizedError } from "../common/errors";
import { type AuthenticatedUser, type AuthTokenPayload, SESSION_COOKIE_NAME } from "./types";

export const DEFAULT_TOKEN_TTL_SECONDS = 3600 * 24; // 24 hours
export const MAX_TOKEN_LIFETIME_SECONDS = 3600 * 24 * 7; // 7 days max lifetime
export const MAX_CLOCK_SKEW_SECONDS = 60; // 60 seconds tolerance for future timestamp check

export class AuthService {
  private readonly secret: string;

  constructor(secret?: string, private readonly client: DbClient = prisma) {
    const resolvedSecret = secret ?? env.AUTH_TOKEN_SIGNING_SECRET;
    if (!resolvedSecret || typeof resolvedSecret !== "string" || resolvedSecret.trim().length < 16) {
      throw new DomainUnauthorizedError(
        "AUTH_TOKEN_SIGNING_SECRET is missing, empty, or shorter than 16 characters"
      );
    }
    this.secret = resolvedSecret;
  }

  /**
   * Generates a signed cryptographic authentication token for a user.
   * Internal server-side helper — not exposed directly to untrusted callers.
   */
  generateToken(
    userId: string,
    options?: { expiresInSeconds?: number; tokenVersion?: number; issuedAt?: number }
  ): string {
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
      throw new DomainUnauthorizedError("Cannot generate token for empty userId");
    }

    const now = options?.issuedAt ?? Math.floor(Date.now() / 1000);
    const ttl = options?.expiresInSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

    if (ttl <= 0 || ttl > MAX_TOKEN_LIFETIME_SECONDS) {
      throw new DomainUnauthorizedError(
        `Token lifetime must be between 1 and ${MAX_TOKEN_LIFETIME_SECONDS} seconds`
      );
    }

    const tokenVersion = options?.tokenVersion ?? 1;

    const payload: AuthTokenPayload = {
      userId,
      tokenVersion,
      issuedAt: now,
      expiresAt: now + ttl,
    };

    const payloadJson = JSON.stringify(payload);
    const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encodedPayload).digest("base64url");

    return `vr_auth.${encodedPayload}.${signature}`;
  }

  /**
   * Verifies token integrity, timestamps, lifetime, and signature using constant-time comparison.
   * Returns decoded payload or throws DomainUnauthorizedError.
   */
  verifyToken(token: string): AuthTokenPayload {
    if (!token || typeof token !== "string" || !token.startsWith("vr_auth.")) {
      throw new DomainUnauthorizedError("Invalid or missing authentication token format");
    }

    const parts = token.slice("vr_auth.".length).split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new DomainUnauthorizedError("Malformed authentication token");
    }

    const encodedPayload = parts[0];
    const providedSignature = parts[1];
    const expectedSignature = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");

    const providedBuffer = Buffer.from(providedSignature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      throw new DomainUnauthorizedError("Authentication token signature verification failed");
    }

    let payload: AuthTokenPayload;
    try {
      const decodedJson = Buffer.from(encodedPayload, "base64url").toString("utf8");
      payload = JSON.parse(decodedJson) as AuthTokenPayload;
    } catch {
      throw new DomainUnauthorizedError("Malformed authentication token payload");
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.userId !== "string" ||
      payload.userId.trim() === "" ||
      typeof payload.issuedAt !== "number" ||
      typeof payload.expiresAt !== "number" ||
      !Number.isFinite(payload.issuedAt) ||
      !Number.isFinite(payload.expiresAt)
    ) {
      throw new DomainUnauthorizedError("Authentication token payload has invalid schema or types");
    }

    const now = Math.floor(Date.now() / 1000);

    // Reject future-issued tokens (outside allowed clock skew)
    if (payload.issuedAt > now + MAX_CLOCK_SKEW_SECONDS) {
      throw new DomainUnauthorizedError("Authentication token issued in the future");
    }

    // Reject expired tokens
    if (payload.expiresAt < now) {
      throw new DomainUnauthorizedError("Authentication token has expired");
    }

    // Reject tokens with excessive lifetime
    if (payload.expiresAt - payload.issuedAt > MAX_TOKEN_LIFETIME_SECONDS) {
      throw new DomainUnauthorizedError("Token lifetime exceeds maximum allowed duration");
    }

    // Validate token version
    if (payload.tokenVersion !== undefined) {
      if (typeof payload.tokenVersion !== "number" || payload.tokenVersion < 1) {
        throw new DomainUnauthorizedError("Invalid token version in authentication token");
      }
    } else {
      payload.tokenVersion = 1;
    }

    return payload;
  }

  /**
   * Helper to parse and extract a named cookie value from a Cookie header string.
   */
  extractCookie(cookieHeader: string | null, cookieName: string): string | null {
    if (!cookieHeader || typeof cookieHeader !== "string") return null;
    const parts = cookieHeader.split(";");
    for (const part of parts) {
      const [key, ...valueParts] = part.trim().split("=");
      if (key === cookieName) {
        return decodeURIComponent(valueParts.join("="));
      }
    }
    return null;
  }

  /**
   * Extracts, verifies, and resolves the authenticated user from an incoming HTTP Request.
   * Accepts either an 'Authorization: Bearer <token>' header or an HTTP-only session cookie ('vr_session').
   * Checks database existence, active/suspended status, and revocation version.
   */
  async authenticateRequest(
    req: Request,
    options?: { tx?: PrismaTransactionClient }
  ): Promise<AuthenticatedUser> {
    let token: string | null = null;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.slice(7).trim();
    } else {
      const cookieHeader = req.headers.get("cookie");
      if (cookieHeader) {
        token = this.extractCookie(cookieHeader, SESSION_COOKIE_NAME);
      }
    }

    if (!token) {
      throw new DomainUnauthorizedError("Missing or invalid Authorization header or session cookie");
    }

    const payload = this.verifyToken(token);

    const db = options?.tx ?? this.client;
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        githubUsername: true,
        isActive: true,
        suspendedAt: true,
        tokenVersion: true,
      },
    });

    if (!user) {
      throw new DomainUnauthorizedError(`Authenticated user '${payload.userId}' no longer exists`);
    }

    if (!user.isActive || user.suspendedAt !== null) {
      throw new DomainUnauthorizedError(`User account '${user.id}' is inactive or suspended`);
    }

    if (payload.tokenVersion < user.tokenVersion) {
      throw new DomainUnauthorizedError(`Authentication token for user '${user.id}' has been revoked`);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      githubUsername: user.githubUsername,
      isActive: user.isActive,
      tokenVersion: user.tokenVersion,
    };
  }
}

export const authService = new AuthService();
