-- ============================================================================
-- Script: scripts/provision-database-roles.sql
-- Description: Provisions the 3 database security roles for VeriRelease:
--   1. verirelease_owner_role (NOLOGIN, owns schema, tables, triggers, functions, types)
--   2. verirelease_deployer (LOGIN, member of owner_role, role default set to owner_role for DDL/migrations)
--   3. verirelease_app_user (LOGIN, NOINHERIT, minimal DML, no DDL, no DELETE/UPDATE on immutable tables)
-- Architecture Reference: docs/milestone-2-design.md Section 3.3
-- ============================================================================

-- 1. Create Migration Owner Role (NOLOGIN)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_owner_role') THEN
    CREATE ROLE verirelease_owner_role NOLOGIN;
  END IF;
END
$$;

-- 2. Create Migration Deployment Role (LOGIN)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_deployer') THEN
    CREATE ROLE verirelease_deployer WITH LOGIN;
  END IF;
END
$$;
GRANT verirelease_owner_role TO verirelease_deployer;

-- Ensure migrations executed by verirelease_deployer automatically run with
-- verirelease_owner_role as the effective user, guaranteeing that all newly
-- created tables, functions, triggers, and types are owned by verirelease_owner_role.
ALTER ROLE verirelease_deployer SET role = 'verirelease_owner_role';

-- 3. Create Application Runtime Role (LOGIN, NOINHERIT)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verirelease_app_user') THEN
    CREATE ROLE verirelease_app_user WITH LOGIN NOINHERIT;
  END IF;
END
$$;

-- 4. Parameterized Credential Provisioning (No hardcoded credentials)
-- Passwords can be supplied dynamically via session settings, e.g.:
--   SET verirelease.deployer_password = '...';
--   SET verirelease.app_user_password = '...';
-- If not set, existing passwords remain untouched.
DO $$
DECLARE
  v_deployer_pw TEXT := current_setting('verirelease.deployer_password', true);
  v_app_user_pw TEXT := current_setting('verirelease.app_user_password', true);
BEGIN
  IF v_deployer_pw IS NOT NULL AND v_deployer_pw <> '' THEN
    EXECUTE format('ALTER ROLE verirelease_deployer WITH PASSWORD %L', v_deployer_pw);
  END IF;
  IF v_app_user_pw IS NOT NULL AND v_app_user_pw <> '' THEN
    EXECUTE format('ALTER ROLE verirelease_app_user WITH PASSWORD %L', v_app_user_pw);
  END IF;
END
$$;

-- 5. Secure Public Schema: Revoke default CREATE privileges from PUBLIC
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO verirelease_owner_role;

-- 6. Grant Runtime DML Permissions on Public Schema
GRANT USAGE ON SCHEMA public TO verirelease_app_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO verirelease_app_user;

-- 7. Restrict Immutable & Protected Tables:
-- Strictly append-only: AuditLog, MilestoneSubmission, AcceptanceCriterion, PaymentReconciliation (NO UPDATE, NO DELETE, NO TRUNCATE)
-- Protected evaluation: PolicyEvaluation allows UPDATE while IN_PROGRESS, but NEVER DELETE or TRUNCATE
DO $$
DECLARE
  t TEXT;
  tbls TEXT[] := ARRAY['AuditLog', 'MilestoneSubmission', 'AcceptanceCriterion', 'PaymentReconciliation'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM verirelease_app_user', t);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'PolicyEvaluation') THEN
    REVOKE DELETE, TRUNCATE ON public."PolicyEvaluation" FROM verirelease_app_user;
  END IF;

  -- Migration evidence: _migration_execution_context is strictly inaccessible to runtime role (REVOKE ALL)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_migration_execution_context') THEN
    REVOKE ALL ON public."_migration_execution_context" FROM verirelease_app_user;
  END IF;
END
$$;

-- 8. Configure Default Privileges for future tables created by owner role
ALTER DEFAULT PRIVILEGES FOR ROLE verirelease_owner_role IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO verirelease_app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE verirelease_owner_role IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE verirelease_owner_role IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO verirelease_app_user;

-- 9. Assign Explicit Ownership to verirelease_owner_role for All Existing Domain Tables, Functions, and Enums
DO $$
DECLARE
  r RECORD;
  t TEXT;
  tbls TEXT[] := ARRAY['User', 'Contract', 'Milestone', 'AcceptanceCriterion', 'MilestoneSubmission', 'PolicyEvaluation', 'PaymentTransaction', 'AuditLog', '_migration_execution_context', 'PaymentReconciliation'];
BEGIN
  -- Tables
  FOREACH t IN ARRAY tbls LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO verirelease_owner_role', t);
    END IF;
  END LOOP;

  -- Functions
  FOR r IN (SELECT proname, oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace) LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO verirelease_owner_role', r.proname, pg_get_function_identity_arguments(r.oid));
  END LOOP;

  -- Enums
  FOR r IN (SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e') LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO verirelease_owner_role', r.typname);
  END LOOP;
END
$$;
