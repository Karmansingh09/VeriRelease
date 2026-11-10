import { PrismaClient, Prisma } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

/**
 * Returns an authoritative database connection URL.
 * Falls back to local Unix socket environment variables when DATABASE_URL is not set.
 */
export function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.PGHOST || "/tmp";
  const port = process.env.PGPORT || "5433";
  const user = process.env.PGUSER || "postgres";
  const database = process.env.PGDATABASE || "verirelease_test";
  return `postgresql://${user}@localhost:${port}/${database}?host=${host}`;
}

export const prisma =
  globalThis.prisma ??
  new PrismaClient({
    datasourceUrl: getDatabaseUrl(),
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}

export type PrismaTransactionClient = Prisma.TransactionClient;
export type DbClient = PrismaClient | Prisma.TransactionClient;
export type { PrismaClient };
