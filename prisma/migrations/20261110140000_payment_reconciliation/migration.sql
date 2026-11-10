-- ============================================================================
-- Migration: 20261110140000_payment_reconciliation
-- VeriRelease Milestone 2 Slice 2.7: Payment Recovery & Reconciliation Foundation
-- Dedicated append-only PaymentReconciliation entity, immutability trigger,
-- check constraints, and role permissions.
-- Architecture Reference: docs/milestone-2-design.md
-- ============================================================================

-- 1. Create ReconciliationDecision Enum
CREATE TYPE "ReconciliationDecision" AS ENUM (
  'CONFIRMED_SUCCEEDED',
  'CONFIRMED_FAILED',
  'STILL_UNCERTAIN'
);

-- 2. Create PaymentReconciliation Table
CREATE TABLE "PaymentReconciliation" (
  "id" VARCHAR(36) PRIMARY KEY,
  "paymentTransactionId" VARCHAR(36) NOT NULL,
  "decision" "ReconciliationDecision" NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceReference" VARCHAR(500),
  "evidenceType" VARCHAR(100),
  "actorType" "AuditActorType" NOT NULL,
  "actorUserId" VARCHAR(36),
  "actorSystemPrincipal" VARCHAR(100),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  -- Foreign keys
  CONSTRAINT "fk_reconciliation_payment"
    FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT,
  CONSTRAINT "fk_reconciliation_actor_user"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT,

  -- Check constraints
  CONSTRAINT "chk_reconciliation_reason"
    CHECK (length(trim("reason")) > 0),
  CONSTRAINT "chk_reconciliation_evidence"
    CHECK (
      ("decision" = 'STILL_UNCERTAIN') OR
      ("evidenceReference" IS NOT NULL AND length(trim("evidenceReference")) > 0)
    ),
  CONSTRAINT "chk_reconciliation_actor"
    CHECK (
      ("actorType" = 'USER' AND "actorUserId" IS NOT NULL AND "actorSystemPrincipal" IS NULL) OR
      ("actorType" <> 'USER' AND "actorUserId" IS NULL AND "actorSystemPrincipal" IS NOT NULL)
    )
);

-- 3. Indexes
CREATE INDEX "idx_reconciliation_payment" ON "PaymentReconciliation"("paymentTransactionId");
CREATE INDEX "idx_reconciliation_actor_user" ON "PaymentReconciliation"("actorUserId");
CREATE INDEX "idx_reconciliation_created" ON "PaymentReconciliation"("createdAt" DESC);

-- 4. Immutability Trigger & Function (SQLSTATE 55000)
CREATE OR REPLACE FUNCTION enforce_reconciliation_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: PaymentReconciliation entries are strictly append-only. Modifying or deleting records is prohibited.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_immutable
BEFORE UPDATE OR DELETE ON "PaymentReconciliation"
FOR EACH ROW EXECUTE FUNCTION enforce_reconciliation_immutability();

-- 5. Role Permissions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_app_user') THEN
    GRANT SELECT, INSERT ON "PaymentReconciliation" TO verirelease_app_user;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PaymentReconciliation" FROM verirelease_app_user;
  END IF;
END
$$;

-- 6. Ownership Assignment
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_owner_role') THEN
    ALTER TABLE "PaymentReconciliation" OWNER TO verirelease_owner_role;
    ALTER FUNCTION enforce_reconciliation_immutability() OWNER TO verirelease_owner_role;
    ALTER TYPE "ReconciliationDecision" OWNER TO verirelease_owner_role;
  END IF;
END
$$;
