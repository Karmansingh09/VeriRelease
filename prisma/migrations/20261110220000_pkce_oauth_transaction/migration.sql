-- ============================================================================
-- Migration: 20261110220000_pkce_oauth_transaction
-- VeriRelease Milestone 3.1: Confidential PKCE Server-Side Transaction Store
-- Adds OAuthTransaction table for confidential, single-use PKCE verifiers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "OAuthTransaction" (
    "id" VARCHAR(36) NOT NULL,
    "stateNonce" VARCHAR(64) NOT NULL,
    "codeVerifier" VARCHAR(128) NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "userId" VARCHAR(36),
    "returnTo" VARCHAR(500) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthTransaction_pkey" PRIMARY KEY ("id")
);

-- Indexes for single-use lookup and expiry cleanup
CREATE UNIQUE INDEX IF NOT EXISTS "idx_oauth_tx_state_nonce" ON "OAuthTransaction"("stateNonce");
CREATE INDEX IF NOT EXISTS "idx_oauth_tx_expires_at" ON "OAuthTransaction"("expiresAt");

-- Grant DML privileges to application runtime role
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OAuthTransaction" TO verirelease_app_user;
