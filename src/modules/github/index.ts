/**
 * VeriRelease GitHub Module
 *
 * Secure, read-only GitHub integration & evidence ingestion.
 */

export * from "./types";
export * from "./provider/github-provider.interface";
export * from "./provider/fetch-github-provider";
export * from "./provider/mock-github-provider";
export * from "./repository/github-repository.interface";
export * from "./repository/prisma-github-repository";
export * from "./repository/github-repo-service";
export * from "./webhook/signature-verifier";
export * from "./webhook/webhook-delivery.interface";
export * from "./webhook/prisma-webhook-delivery-repository";
export * from "./webhook/webhook-delivery-service";
export * from "./evidence/evidence-snapshot.interface";
export * from "./evidence/prisma-evidence-repository";
export * from "./evidence/github-evidence-service";
