-- ============================================================================
-- Migration: 20261110200000_github_evidence_ingestion
-- VeriRelease Milestone 3: GitHub Integration & Evidence Ingestion
-- Adds GitHubRepository, GitHubWebhookDelivery, GitHubEvidenceSnapshot,
-- immutability triggers, check constraints, and role permissions.
-- Architecture Reference: docs/milestone-3-design.md
-- ============================================================================

-- 1. Extend AuditEntityType Enum
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'GITHUB_REPOSITORY';
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'GITHUB_DELIVERY';
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'EVIDENCE_SNAPSHOT';

-- 2. Create Enums for Deliveries and Checks
CREATE TYPE "GitHubDeliveryStatus" AS ENUM (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED'
);

CREATE TYPE "GitHubCheckStatus" AS ENUM (
  'PENDING',
  'SUCCESS',
  'FAILURE',
  'UNAVAILABLE'
);

-- 2b. Add User Authentication Hardening Columns
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMPTZ(6);

-- 3. Create GitHubRepository Table
CREATE TABLE "GitHubRepository" (
  "id" VARCHAR(36) PRIMARY KEY,
  "repoId" BIGINT NOT NULL,
  "owner" VARCHAR(100) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "fullName" VARCHAR(200) NOT NULL,
  "installationId" BIGINT,
  "isPrivate" BOOLEAN NOT NULL DEFAULT false,
  "defaultBranch" VARCHAR(100) NOT NULL DEFAULT 'main',
  "htmlUrl" VARCHAR(500) NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "uq_github_repo_id" UNIQUE ("repoId"),
  CONSTRAINT "chk_github_repo_owner" CHECK (length(trim("owner")) > 0),
  CONSTRAINT "chk_github_repo_name" CHECK (length(trim("name")) > 0),
  CONSTRAINT "chk_github_repo_full_name" CHECK (length(trim("fullName")) > 0)
);

CREATE INDEX "idx_github_repo_owner_name" ON "GitHubRepository"("owner", "name");

-- 4. Alter Contract Table to Associate GitHubRepository
ALTER TABLE "Contract" ADD COLUMN "githubRepoId" BIGINT;

ALTER TABLE "Contract"
  ADD CONSTRAINT "fk_contract_github_repo"
  FOREIGN KEY ("githubRepoId") REFERENCES "GitHubRepository"("repoId") ON DELETE RESTRICT;

-- 5. Create GitHubWebhookDelivery Table
CREATE TABLE "GitHubWebhookDelivery" (
  "id" VARCHAR(36) PRIMARY KEY,
  "deliveryId" VARCHAR(64) NOT NULL,
  "eventType" VARCHAR(50) NOT NULL,
  "action" VARCHAR(50),
  "status" "GitHubDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
  "repositoryId" BIGINT,
  "payload" JSONB NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "errorMessage" TEXT,
  "processedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "uq_github_delivery_id" UNIQUE ("deliveryId"),
  CONSTRAINT "chk_github_delivery_id_format" CHECK (length(trim("deliveryId")) >= 1 AND length(trim("deliveryId")) <= 64),
  CONSTRAINT "chk_github_delivery_payload_hash" CHECK (length("payloadHash") = 64)
);

CREATE INDEX "idx_github_delivery_status" ON "GitHubWebhookDelivery"("status");
CREATE INDEX "idx_github_delivery_repo" ON "GitHubWebhookDelivery"("repositoryId");
CREATE INDEX "idx_github_delivery_created" ON "GitHubWebhookDelivery"("createdAt" DESC);

-- 6. Create GitHubEvidenceSnapshot Table
CREATE TABLE "GitHubEvidenceSnapshot" (
  "id" VARCHAR(36) PRIMARY KEY,
  "submissionId" VARCHAR(36) NOT NULL,
  "milestoneId" VARCHAR(36) NOT NULL,
  "snapshotVersion" INTEGER NOT NULL DEFAULT 1,
  "repositoryId" BIGINT NOT NULL,
  "repoOwner" VARCHAR(100) NOT NULL,
  "repoName" VARCHAR(100) NOT NULL,
  "prNumber" INTEGER NOT NULL,
  "prId" BIGINT,
  "prUrl" VARCHAR(1000) NOT NULL,
  "prTitle" VARCHAR(500) NOT NULL,
  "prBody" TEXT,
  "prAuthor" VARCHAR(100) NOT NULL,
  "prAuthorId" BIGINT,
  "prState" VARCHAR(50) NOT NULL,
  "isMerged" BOOLEAN NOT NULL DEFAULT false,
  "mergedAt" TIMESTAMPTZ(6),
  "mergeCommitSha" VARCHAR(40),
  "headBranch" VARCHAR(200) NOT NULL,
  "headCommitSha" VARCHAR(40) NOT NULL,
  "baseBranch" VARCHAR(200) NOT NULL,
  "baseCommitSha" VARCHAR(40) NOT NULL,
  "commitCount" INTEGER NOT NULL DEFAULT 0,
  "commits" JSONB NOT NULL,
  "checks" JSONB NOT NULL,
  "checksStatus" "GitHubCheckStatus" NOT NULL DEFAULT 'UNAVAILABLE',
  "rawPayload" JSONB,
  "evidenceHash" VARCHAR(64) NOT NULL,
  "collectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "provider" VARCHAR(50) NOT NULL DEFAULT 'github',
  "apiVersion" VARCHAR(50) NOT NULL DEFAULT '2022-11-28',

  -- Scoped Composite Foreign Key
  CONSTRAINT "fk_evidence_submission_milestone_scoped"
    FOREIGN KEY ("submissionId", "milestoneId") REFERENCES "MilestoneSubmission"("id", "milestoneId") ON DELETE RESTRICT,

  -- Unique constraint on submission + snapshotVersion
  CONSTRAINT "uq_submission_evidence_version" UNIQUE ("submissionId", "snapshotVersion"),

  -- Check constraints
  CONSTRAINT "chk_evidence_pr_number" CHECK ("prNumber" > 0),
  CONSTRAINT "chk_evidence_snapshot_version" CHECK ("snapshotVersion" > 0),
  CONSTRAINT "chk_evidence_head_sha" CHECK (length("headCommitSha") = 40),
  CONSTRAINT "chk_evidence_base_sha" CHECK (length("baseCommitSha") = 40),
  CONSTRAINT "chk_evidence_hash" CHECK (length("evidenceHash") = 64)
);

CREATE INDEX "idx_evidence_submission" ON "GitHubEvidenceSnapshot"("submissionId");
CREATE INDEX "idx_evidence_milestone" ON "GitHubEvidenceSnapshot"("milestoneId");
CREATE INDEX "idx_evidence_repo" ON "GitHubEvidenceSnapshot"("repositoryId");

-- 7. Immutability Trigger & Function (SQLSTATE 55000)
CREATE OR REPLACE FUNCTION enforce_evidence_snapshot_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: GitHubEvidenceSnapshot entries are strictly append-only. Modifying or deleting records is prohibited.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_evidence_snapshot_immutable
BEFORE UPDATE OR DELETE ON "GitHubEvidenceSnapshot"
FOR EACH ROW EXECUTE FUNCTION enforce_evidence_snapshot_immutability();

-- 8. Role Permissions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_app_user') THEN
    GRANT SELECT, INSERT ON "GitHubEvidenceSnapshot" TO verirelease_app_user;
    REVOKE UPDATE, DELETE, TRUNCATE ON "GitHubEvidenceSnapshot" FROM verirelease_app_user;

    GRANT SELECT, INSERT, UPDATE ON "GitHubWebhookDelivery" TO verirelease_app_user;
    REVOKE DELETE, TRUNCATE ON "GitHubWebhookDelivery" FROM verirelease_app_user;

    GRANT SELECT, INSERT, UPDATE ON "GitHubRepository" TO verirelease_app_user;
    REVOKE DELETE, TRUNCATE ON "GitHubRepository" FROM verirelease_app_user;
  END IF;
END
$$;

-- 9. Ownership Assignment
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_owner_role') THEN
    ALTER TABLE "GitHubRepository" OWNER TO verirelease_owner_role;
    ALTER TABLE "GitHubWebhookDelivery" OWNER TO verirelease_owner_role;
    ALTER TABLE "GitHubEvidenceSnapshot" OWNER TO verirelease_owner_role;
    ALTER FUNCTION enforce_evidence_snapshot_immutability() OWNER TO verirelease_owner_role;
    ALTER TYPE "GitHubDeliveryStatus" OWNER TO verirelease_owner_role;
    ALTER TYPE "GitHubCheckStatus" OWNER TO verirelease_owner_role;
  END IF;
END
$$;
