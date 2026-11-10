/**
 * Server-Side Confidential OAuth PKCE Transaction Store
 *
 * Implements server-side storage and single-use atomic consumption of
 * PKCE code_verifiers, binding each verifier to the cryptographic state nonce,
 * intended action, initiating user ID, and expiration timestamp.
 */

import { randomUUID } from "node:crypto";
import type { DbClient } from "../../lib/prisma";
import { DomainUnauthorizedError } from "../common/errors";
import type { OAuthTransactionRecord, OAuthTransactionStore } from "./types";

/**
 * PostgreSQL/Prisma implementation of OAuthTransactionStore.
 * Guarantees atomic consumption via PostgreSQL `UPDATE ... RETURNING`.
 */
export class PrismaOAuthTransactionStore implements OAuthTransactionStore {
  constructor(private readonly client: DbClient) {}

  async create(
    tx: Omit<OAuthTransactionRecord, "id" | "consumedAt" | "createdAt">
  ): Promise<OAuthTransactionRecord> {
    const id = `oat_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const created = await this.client.oAuthTransaction.create({
      data: {
        id,
        stateNonce: tx.stateNonce,
        codeVerifier: tx.codeVerifier,
        action: tx.action,
        userId: tx.userId,
        returnTo: tx.returnTo,
        expiresAt: tx.expiresAt,
      },
    });

    return created as OAuthTransactionRecord;
  }

  async consume(stateNonce: string, now: Date = new Date()): Promise<OAuthTransactionRecord> {
    // Atomic single-use consumption in PostgreSQL
    const rows = await this.client.$queryRaw<Array<OAuthTransactionRecord>>`
      UPDATE "OAuthTransaction"
      SET "consumedAt" = ${now}
      WHERE "stateNonce" = ${stateNonce}
        AND "consumedAt" IS NULL
        AND "expiresAt" > ${now}
      RETURNING "id", "stateNonce", "codeVerifier", "action", "userId", "returnTo", "expiresAt", "consumedAt", "createdAt";
    `;

    if (rows && rows.length > 0 && rows[0]) {
      return rows[0];
    }

    // Diagnostic investigation when atomic update returned 0 rows
    const existing = await this.client.oAuthTransaction.findUnique({
      where: { stateNonce },
    });

    if (!existing) {
      throw new DomainUnauthorizedError("OAuth transaction not found or state nonce is invalid");
    }
    if (existing.consumedAt) {
      throw new DomainUnauthorizedError(
        "OAuth transaction has already been consumed (replay attack detected)"
      );
    }
    if (existing.expiresAt <= now) {
      throw new DomainUnauthorizedError("OAuth transaction has expired");
    }

    throw new DomainUnauthorizedError("OAuth transaction could not be consumed");
  }

  async pruneExpired(now: Date = new Date()): Promise<number> {
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
    const result = await this.client.oAuthTransaction.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { consumedAt: { not: null, lt: oneHourAgo } },
        ],
      },
    });
    return result.count;
  }
}

/**
 * In-memory implementation of OAuthTransactionStore.
 * Used for isolated unit tests and mock environments.
 */
export class InMemoryOAuthTransactionStore implements OAuthTransactionStore {
  private readonly transactions = new Map<string, OAuthTransactionRecord>();

  async create(
    tx: Omit<OAuthTransactionRecord, "id" | "consumedAt" | "createdAt">
  ): Promise<OAuthTransactionRecord> {
    const record: OAuthTransactionRecord = {
      id: `oat_mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      stateNonce: tx.stateNonce,
      codeVerifier: tx.codeVerifier,
      action: tx.action,
      userId: tx.userId,
      returnTo: tx.returnTo,
      expiresAt: tx.expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };

    this.transactions.set(tx.stateNonce, record);
    return { ...record };
  }

  async consume(stateNonce: string, now: Date = new Date()): Promise<OAuthTransactionRecord> {
    const existing = this.transactions.get(stateNonce);

    if (!existing) {
      throw new DomainUnauthorizedError("OAuth transaction not found or state nonce is invalid");
    }
    if (existing.consumedAt !== null) {
      throw new DomainUnauthorizedError(
        "OAuth transaction has already been consumed (replay attack detected)"
      );
    }
    if (existing.expiresAt <= now) {
      throw new DomainUnauthorizedError("OAuth transaction has expired");
    }

    // Atomic consumption
    existing.consumedAt = now;
    return { ...existing };
  }

  async pruneExpired(now: Date = new Date()): Promise<number> {
    let pruned = 0;
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);

    for (const [nonce, tx] of this.transactions.entries()) {
      if (tx.expiresAt < now || (tx.consumedAt !== null && tx.consumedAt < oneHourAgo)) {
        this.transactions.delete(nonce);
        pruned++;
      }
    }

    return pruned;
  }

  // Test inspection helper
  get(stateNonce: string): OAuthTransactionRecord | undefined {
    return this.transactions.get(stateNonce);
  }
}
