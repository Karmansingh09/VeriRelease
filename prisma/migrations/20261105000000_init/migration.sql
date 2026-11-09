-- ============================================================================
-- Migration: 20261105000000_init
-- VeriRelease Milestone 2 Schema Foundation: Enums, Tables, Constraints, Indexes,
-- Immutability Triggers, Allocation Triggers, and Foreign Keys
-- Architecture Reference: docs/milestone-2-design.md v2.8.0
-- ============================================================================

-- 1. ENUMS

CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

CREATE TYPE "MilestoneStatus" AS ENUM (
  'DRAFT',
  'FUNDED',
  'SUBMITTED',
  'EVALUATING',
  'ELIGIBLE_FOR_PAYOUT',
  'CHANGES_REQUESTED',
  'DISPUTED',
  'CANCELLED'
);

CREATE TYPE "CriterionType" AS ENUM (
  'AUTOMATED_TEST',
  'FILE_CHANGE',
  'CODE_QUALITY',
  'SPECIFICATION',
  'MANUAL_APPROVAL'
);

CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'EVALUATED', 'SUPERSEDED');

CREATE TYPE "PolicyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

CREATE TYPE "PolicyDecision" AS ENUM ('PASS', 'FAIL');

CREATE TYPE "PaymentTxType" AS ENUM ('FUNDING_AUTHORIZATION', 'PAYOUT', 'REFUND');

CREATE TYPE "PaymentTxStatus" AS ENUM (
  'CREATED',
  'RESERVED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'PAYOUT_UNCERTAIN',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE "AuditEntityType" AS ENUM (
  'CONTRACT',
  'MILESTONE',
  'PAYMENT',
  'RECEIPT',
  'CRITERIA',
  'SUBMISSION',
  'POLICY_EVALUATION'
);

CREATE TYPE "AuditActorType" AS ENUM (
  'USER',
  'SYSTEM_PRINCIPAL',
  'WEBHOOK_GITHUB',
  'WEBHOOK_PAYPAL'
);

-- 2. USER TABLE

CREATE TABLE "User" (
  "id" VARCHAR(36) PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "name" VARCHAR(255) NOT NULL,
  "role" VARCHAR(20) NOT NULL,
  "paypalPayerId" VARCHAR(100),
  "paypalReceiverEmail" VARCHAR(255),
  "githubUsername" VARCHAR(100),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. CONTRACT TABLE

CREATE TABLE "Contract" (
  "id" VARCHAR(36) PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "clientId" VARCHAR(36) NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "developerId" VARCHAR(36) NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
  "totalAmountMinorUnits" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "githubRepoOwner" VARCHAR(100) NOT NULL,
  "githubRepoName" VARCHAR(100) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_contract_actors" CHECK ("clientId" <> "developerId"),
  CONSTRAINT "chk_contract_positive_amount" CHECK ("totalAmountMinorUnits" > 0),
  CONSTRAINT "chk_contract_supported_currency" CHECK (
    "currency" IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'JPY', 'KRW', 'BHD', 'KWD', 'OMR')
  ),
  CONSTRAINT "uq_contract_id_currency" UNIQUE ("id", "currency")
);

CREATE INDEX "idx_contract_client" ON "Contract"("clientId");
CREATE INDEX "idx_contract_developer" ON "Contract"("developerId");

-- 4. MILESTONE TABLE

CREATE TABLE "Milestone" (
  "id" VARCHAR(36) PRIMARY KEY,
  "contractId" VARCHAR(36) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  "amountMinorUnits" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "status" "MilestoneStatus" NOT NULL DEFAULT 'DRAFT',
  "activeCriteriaVersion" INTEGER NOT NULL DEFAULT 1,
  "fundedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_milestone_contract_currency" 
    FOREIGN KEY ("contractId", "currency") 
    REFERENCES "Contract"("id", "currency") 
    ON DELETE RESTRICT,
  CONSTRAINT "uq_contract_milestone_order" UNIQUE ("contractId", "orderIndex"),
  CONSTRAINT "uq_milestone_id_currency" UNIQUE ("id", "currency"),
  CONSTRAINT "chk_milestone_positive_amount" CHECK ("amountMinorUnits" > 0),
  CONSTRAINT "chk_milestone_order_positive" CHECK ("orderIndex" > 0),
  CONSTRAINT "chk_milestone_supported_currency" CHECK (
    "currency" IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'JPY', 'KRW', 'BHD', 'KWD', 'OMR')
  ),
  CONSTRAINT "chk_milestone_criteria_version_positive" CHECK ("activeCriteriaVersion" > 0)
);

CREATE INDEX "idx_milestone_contract" ON "Milestone"("contractId");

-- 5. MILESTONE ALLOCATION CONCURRENCY TRIGGERS

CREATE OR REPLACE FUNCTION check_milestone_allocation_on_milestone()
RETURNS TRIGGER AS $$
DECLARE
  v_contract_total BIGINT;
  v_allocated_total BIGINT;
BEGIN
  -- Row lock on parent Contract to serialize concurrent milestone allocations
  SELECT "totalAmountMinorUnits" INTO v_contract_total 
  FROM "Contract" 
  WHERE "id" = NEW."contractId" 
  FOR UPDATE;

  SELECT COALESCE(SUM("amountMinorUnits"), 0) INTO v_allocated_total 
  FROM "Milestone" 
  WHERE "contractId" = NEW."contractId" AND "id" <> COALESCE(NEW."id", '');

  IF (v_allocated_total + NEW."amountMinorUnits") > v_contract_total THEN
    RAISE EXCEPTION 'Total milestone allocations (% + %) exceed contract total (%)',
      v_allocated_total, NEW."amountMinorUnits", v_contract_total
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_milestone_allocation
BEFORE INSERT OR UPDATE OF "amountMinorUnits", "contractId" ON "Milestone"
FOR EACH ROW EXECUTE FUNCTION check_milestone_allocation_on_milestone();

CREATE OR REPLACE FUNCTION check_contract_total_reduction()
RETURNS TRIGGER AS $$
DECLARE
  v_allocated_total BIGINT;
BEGIN
  SELECT COALESCE(SUM("amountMinorUnits"), 0) INTO v_allocated_total 
  FROM "Milestone" 
  WHERE "contractId" = NEW."id";

  IF NEW."totalAmountMinorUnits" < v_allocated_total THEN
    RAISE EXCEPTION 'Contract total (%) cannot be reduced below existing milestone allocations (%)',
      NEW."totalAmountMinorUnits", v_allocated_total
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_contract_total_reduction
BEFORE UPDATE OF "totalAmountMinorUnits" ON "Contract"
FOR EACH ROW EXECUTE FUNCTION check_contract_total_reduction();

-- 6. ACCEPTANCE CRITERION TABLE (IMMUTABLE VERSIONING)

CREATE TABLE "AcceptanceCriterion" (
  "id" VARCHAR(36) PRIMARY KEY,
  "milestoneId" VARCHAR(36) NOT NULL REFERENCES "Milestone"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "orderIndex" INTEGER NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "criterionType" "CriterionType" NOT NULL,
  "isMandatory" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_milestone_criterion_version_order" UNIQUE ("milestoneId", "version", "orderIndex"),
  CONSTRAINT "chk_criterion_version_positive" CHECK ("version" > 0),
  CONSTRAINT "chk_criterion_order_positive" CHECK ("orderIndex" > 0)
);

CREATE INDEX "idx_criterion_milestone_version" ON "AcceptanceCriterion"("milestoneId", "version");

CREATE OR REPLACE FUNCTION enforce_criteria_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: AcceptanceCriterion records are strictly immutable. Amendments must be inserted as a new version.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_criteria_immutable
BEFORE UPDATE OR DELETE ON "AcceptanceCriterion"
FOR EACH ROW EXECUTE FUNCTION enforce_criteria_immutability();

-- 7. MILESTONE SUBMISSIONS TABLE (IMMUTABLE SNAPSHOTS)

CREATE TABLE "MilestoneSubmission" (
  "id" VARCHAR(36) PRIMARY KEY,
  "milestoneId" VARCHAR(36) NOT NULL REFERENCES "Milestone"("id") ON DELETE RESTRICT,
  "submissionNumber" INTEGER NOT NULL,
  "prNumber" INTEGER NOT NULL,
  "prCommitSha" VARCHAR(40) NOT NULL,
  "prUrl" VARCHAR(1000) NOT NULL,
  "criteriaVersion" INTEGER NOT NULL,
  "criteriaSnapshot" JSONB NOT NULL,
  "criteriaHash" VARCHAR(64) NOT NULL,
  "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "submittedById" VARCHAR(36) NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_milestone_submission_number" UNIQUE ("milestoneId", "submissionNumber"),
  CONSTRAINT "uq_submission_milestone_hash" UNIQUE ("id", "milestoneId", "criteriaHash"),
  CONSTRAINT "uq_submission_id_milestone_id" UNIQUE ("id", "milestoneId"),
  CONSTRAINT "chk_submission_number_positive" CHECK ("submissionNumber" > 0),
  CONSTRAINT "chk_pr_number_positive" CHECK ("prNumber" > 0),
  CONSTRAINT "chk_pr_commit_sha_hex" CHECK ("prCommitSha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "chk_criteria_hash_hex" CHECK ("criteriaHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_submission_criteria_version_positive" CHECK ("criteriaVersion" > 0)
);

CREATE INDEX "idx_submission_milestone" ON "MilestoneSubmission"("milestoneId");
CREATE INDEX "idx_submission_user" ON "MilestoneSubmission"("submittedById");

CREATE OR REPLACE FUNCTION enforce_submission_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: MilestoneSubmission records are strictly immutable. Modification or deletion is prohibited.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_submission_immutable
BEFORE UPDATE OR DELETE ON "MilestoneSubmission"
FOR EACH ROW EXECUTE FUNCTION enforce_submission_immutability();

-- 8. POLICY EVALUATIONS TABLE

CREATE TABLE "PolicyEvaluation" (
  "id" VARCHAR(36) PRIMARY KEY,
  "submissionId" VARCHAR(36) NOT NULL,
  "milestoneId" VARCHAR(36) NOT NULL,
  "criteriaHash" VARCHAR(64) NOT NULL,
  "evaluationNumber" INTEGER NOT NULL DEFAULT 1,
  "policyVersion" VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  "status" "PolicyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "decision" "PolicyDecision",
  "decisionReason" TEXT,
  "evaluations" JSONB,
  "receiptHash" VARCHAR(64),
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_policy_eval_submission_consistency"
    FOREIGN KEY ("submissionId", "milestoneId", "criteriaHash")
    REFERENCES "MilestoneSubmission"("id", "milestoneId", "criteriaHash")
    ON DELETE RESTRICT,
  CONSTRAINT "uq_submission_evaluation_number" UNIQUE ("submissionId", "evaluationNumber"),
  CONSTRAINT "chk_evaluation_number_positive" CHECK ("evaluationNumber" > 0),
  CONSTRAINT "chk_evaluation_criteria_hash_hex" CHECK ("criteriaHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_completed_evaluation_invariants" CHECK (
    "status" <> 'COMPLETED' OR 
    ("decision" IS NOT NULL AND "completedAt" IS NOT NULL AND "evaluations" IS NOT NULL)
  )
);

CREATE INDEX "idx_policy_eval_milestone" ON "PolicyEvaluation"("milestoneId");
CREATE INDEX "idx_policy_eval_submission" ON "PolicyEvaluation"("submissionId");

CREATE OR REPLACE FUNCTION enforce_policy_evaluation_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION 'SECURITY VIOLATION: Completed PolicyEvaluation records are strictly immutable.'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SECURITY VIOLATION: PolicyEvaluation records cannot be deleted.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_policy_eval_immutable
BEFORE UPDATE OR DELETE ON "PolicyEvaluation"
FOR EACH ROW EXECUTE FUNCTION enforce_policy_evaluation_immutability();

-- 9. PAYMENT TRANSACTIONS TABLE

CREATE TABLE "PaymentTransaction" (
  "id" VARCHAR(36) PRIMARY KEY,
  "milestoneId" VARCHAR(36) NOT NULL,
  "submissionId" VARCHAR(36),
  "transactionType" "PaymentTxType" NOT NULL,
  "status" "PaymentTxStatus" NOT NULL DEFAULT 'CREATED',
  "idempotencyKey" VARCHAR(128) NOT NULL UNIQUE,
  "amountMinorUnits" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  "paypalOrderId" VARCHAR(100),
  "paypalCaptureId" VARCHAR(100),
  "paypalPayoutBatchId" VARCHAR(100),
  "paypalPayoutItemId" VARCHAR(100),
  "errorCode" VARCHAR(100),
  "errorMessage" VARCHAR(1000),
  "rawRequest" JSONB,
  "rawResponse" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_payment_attempt" UNIQUE ("milestoneId", "transactionType", "attemptNumber"),
  CONSTRAINT "chk_payment_positive_amount" CHECK ("amountMinorUnits" > 0),
  CONSTRAINT "chk_payment_attempt_positive" CHECK ("attemptNumber" > 0),
  CONSTRAINT "chk_payment_supported_currency" CHECK (
    "currency" IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'JPY', 'KRW', 'BHD', 'KWD', 'OMR')
  ),
  CONSTRAINT "chk_payment_payout_requires_submission" CHECK (
    ("transactionType" = 'PAYOUT'  AND "submissionId" IS NOT NULL) OR
    ("transactionType" <> 'PAYOUT' AND "submissionId" IS NULL)
  ),
  CONSTRAINT "fk_payment_milestone_currency"
    FOREIGN KEY ("milestoneId", "currency")
    REFERENCES "Milestone"("id", "currency")
    ON DELETE RESTRICT,
  CONSTRAINT "fk_payment_submission_milestone_scoped"
    FOREIGN KEY ("submissionId", "milestoneId")
    REFERENCES "MilestoneSubmission"("id", "milestoneId")
    MATCH SIMPLE
    ON DELETE RESTRICT
);

CREATE INDEX "idx_payment_milestone" ON "PaymentTransaction"("milestoneId");
CREATE INDEX "idx_payment_submission" ON "PaymentTransaction"("submissionId");

CREATE UNIQUE INDEX "idx_single_active_payment_per_milestone"
ON "PaymentTransaction" ("milestoneId")
WHERE "status" IN ('RESERVED', 'PROCESSING', 'PAYOUT_UNCERTAIN', 'RECONCILIATION_REQUIRED');

CREATE UNIQUE INDEX "idx_single_succeeded_payout_per_milestone"
ON "PaymentTransaction" ("milestoneId")
WHERE "status" = 'SUCCEEDED' AND "transactionType" = 'PAYOUT';

-- 10. AUDIT LOG TABLE

CREATE TABLE "AuditLog" (
  "id" VARCHAR(36) PRIMARY KEY,
  "entityType" "AuditEntityType" NOT NULL,
  "entityId" VARCHAR(36) NOT NULL,
  "actorType" "AuditActorType" NOT NULL,
  "actorUserId" VARCHAR(36) REFERENCES "User"("id") ON DELETE RESTRICT,
  "actorSystemPrincipal" VARCHAR(100),
  "action" VARCHAR(100) NOT NULL,
  "previousState" JSONB,
  "newState" JSONB,
  "metadata" JSONB,
  "correlationId" VARCHAR(64) NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_audit_actor_consistency" CHECK (
    ("actorType" = 'USER' AND "actorUserId" IS NOT NULL AND "actorSystemPrincipal" IS NULL) OR
    ("actorType" <> 'USER' AND "actorUserId" IS NULL AND "actorSystemPrincipal" IS NOT NULL)
  )
);

CREATE INDEX "idx_audit_entity" ON "AuditLog" ("entityType", "entityId");
CREATE INDEX "idx_audit_timestamp" ON "AuditLog" ("timestamp" DESC);
CREATE INDEX "idx_audit_correlation" ON "AuditLog" ("correlationId");
CREATE INDEX "idx_audit_user" ON "AuditLog" ("actorUserId");

CREATE OR REPLACE FUNCTION enforce_audit_log_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: AuditLog entries are strictly append-only. Modifying or deleting records is prohibited.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION enforce_audit_log_immutability();

-- 11. REVOKE PRIVILEGES ON IMMUTABLE AND RESTRICTED TABLES FROM APPLICATION RUNTIME ROLE
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_app_user') THEN
    -- Strictly append-only tables: NO UPDATE, NO DELETE, NO TRUNCATE
    REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM verirelease_app_user;
    REVOKE UPDATE, DELETE, TRUNCATE ON "MilestoneSubmission" FROM verirelease_app_user;
    REVOKE UPDATE, DELETE, TRUNCATE ON "AcceptanceCriterion" FROM verirelease_app_user;
    -- PolicyEvaluation: Allow UPDATE while IN_PROGRESS; prohibit DELETE and TRUNCATE.
    -- Immutability of COMPLETED evaluations is enforced by trg_policy_eval_immutable.
    REVOKE DELETE, TRUNCATE ON "PolicyEvaluation" FROM verirelease_app_user;
  END IF;
END
$$;

-- 12. RECORD MIGRATION EXECUTION CONTEXT IDENTITY
CREATE TABLE "_migration_execution_context" (
  "migration_name" VARCHAR(255) PRIMARY KEY,
  "session_user" VARCHAR(100) NOT NULL,
  "current_user" VARCHAR(100) NOT NULL,
  "current_role" VARCHAR(100) NOT NULL,
  "executed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO "_migration_execution_context" ("migration_name", "session_user", "current_user", "current_role")
VALUES ('20261105000000_init', SESSION_USER, CURRENT_USER, CURRENT_ROLE);

-- Immutability trigger for migration evidence
CREATE OR REPLACE FUNCTION enforce_migration_context_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: _migration_execution_context records are strictly immutable. Modification or deletion is prohibited.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_migration_context_immutable
BEFORE UPDATE OR DELETE ON "_migration_execution_context"
FOR EACH ROW EXECUTE FUNCTION enforce_migration_context_immutability();

-- Explicitly revoke ALL permissions on _migration_execution_context from application runtime role
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_app_user') THEN
    REVOKE ALL ON TABLE "_migration_execution_context" FROM verirelease_app_user;
  END IF;
END
$$;



