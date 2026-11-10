-- ============================================================================
-- Migration: 20261110210000_github_oauth_session
-- VeriRelease Milestone 3.1: Verified GitHub OAuth Identity Linking & Secure Session Delivery
-- Adds USER to AuditEntityType, adds githubId to User, and enforces unique partial indexes
-- on User.githubUsername and User.githubId.
-- ============================================================================

-- 1. Extend AuditEntityType Enum
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'USER';

-- 2. Add githubId to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "githubId" VARCHAR(100);

-- 3. Case-Insensitive Unique Partial Index on githubUsername (prevent identity claiming conflicts)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_github_username_lower" ON "User" (LOWER("githubUsername")) WHERE "githubUsername" IS NOT NULL;

-- 4. Unique Partial Index on githubId
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_github_id" ON "User" ("githubId") WHERE "githubId" IS NOT NULL;
