# VeriRelease Database Roles, Security Architecture & Deployment Guide

## 1. Overview

VeriRelease enforces strict separation of duties and defense-in-depth across the persistence tier to protect financial records, policy decisions, and audit trails. The database role architecture strictly separates schema evolution and migration execution (DDL) from normal application runtime operations (DML).

## 2. Role Taxonomy

| Role Name | Type | Inherit | Privileges & Purpose |
|:---|:---|:---|:---|
| `verirelease_owner_role` | `NOLOGIN` | N/A | Schema owner. Owns `public` schema, all domain tables, triggers, trigger functions, enums, and indexes. Cannot log in directly. |
| `verirelease_deployer` | `LOGIN` | Inherits owner | Migration deployment role used by CI/CD pipelines (`MIGRATION_DATABASE_URL`). Member of `verirelease_owner_role`. Role default is configured to execute migrations with `current_user = verirelease_owner_role`. |
| `verirelease_app_user` | `LOGIN` | `NOINHERIT` | Application runtime role (`DATABASE_URL`). Minimal necessary DML (`SELECT`, `INSERT`, `UPDATE` on mutable tables and `IN_PROGRESS` evaluations; `SELECT` and `INSERT` only on strictly immutable tables). Completely excluded from DDL and trigger management. |

---

## 3. Migration Ownership Workflow & Verification

### A. Role Switching Mechanism
To ensure that all objects created during migration execution are owned by `verirelease_owner_role` rather than the personal login role `verirelease_deployer`, the provisioning script configures a persistent role-level default:
```sql
ALTER ROLE verirelease_deployer SET role = 'verirelease_owner_role';
```
When `verirelease_deployer` authenticates:
1. `session_user` is authenticated as `verirelease_deployer`.
2. PostgreSQL automatically sets `current_user` to `verirelease_owner_role`.
3. Any object created (`CREATE TABLE`, `CREATE FUNCTION`, `CREATE TRIGGER`, `CREATE TYPE`, `CREATE INDEX`) is directly owned by `verirelease_owner_role`.

In addition, migration connection strings can provide the session option:
```
postgresql://verirelease_deployer:<password>@<host>:<port>/<dbname>?options=-c%20role=verirelease_owner_role
```

### B. Verified Role Context
Querying PostgreSQL session identity when connected as `verirelease_deployer` (via `psql` or Prisma Client / Prisma CLI):
```sql
SELECT session_user, current_user, current_role;
```
Verified actual output:
```
-[ RECORD 1 ]+-----------------------
session_user | verirelease_deployer
current_user | verirelease_owner_role
current_role | verirelease_owner_role
```

### C. Ownership Verification Query
To verify that all tables, trigger functions, enums, and indexes are strictly owned by `verirelease_owner_role`:
```sql
SELECT 'table' AS kind, tablename AS name, tableowner AS owner FROM pg_tables WHERE schemaname = 'public'
UNION ALL
SELECT 'function' AS kind, proname AS name, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace = 'public'::regnamespace
UNION ALL
SELECT 'type' AS kind, typname AS name, pg_get_userbyid(typowner) AS owner FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
ORDER BY kind, name;
```
Every row reports `owner = verirelease_owner_role`.

---

## 4. Secure Credential Provisioning & Rotation

No passwords or credentials are hardcoded in SQL scripts, committed source code, or repository documentation. Passwords must never be passed as command-line arguments (`-c "..."` or `--password`), nor embedded in command-line database connection strings (`psql "postgresql://user:password@host/db"`), preventing exposure in process listings (`ps aux`, `/proc/<pid>/cmdline`) or command history.

### A. Protecting Connection Credentials via Protected Password Files (`.pgpass`)
When authenticating administrative or deployment connections, credentials must never be passed in command-line arguments. Instead, use a protected password file (`PGPASSFILE` or `~/.pgpass`) with restrictive permissions (`chmod 600`):

1. **Secure File Creation**:
   Always create temporary password files using `mktemp` rather than predictable paths in `/tmp` to prevent symlink attacks and race conditions in shared directories. Ensure a cleanup trap removes the file upon shell exit or interruption:
   ```bash
   ADMIN_PGPASS=$(mktemp)
   chmod 0600 "$ADMIN_PGPASS"
   trap 'rm -f "$ADMIN_PGPASS"' EXIT
   ```

2. **Special Character Escaping in `.pgpass`**:
   The format of `.pgpass` entries is `hostname:port:database:username:password`.
   If the password contains colon (`:`) or backslash (`\`) characters, each must be escaped with a preceding backslash (`\:` and `\\`).
   ```bash
   # Example: Escaping colons and backslashes in bash
   ESCAPED_ADMIN_PW="${ADMIN_PASSWORD//\\/\\\\}"
   ESCAPED_ADMIN_PW="${ESCAPED_ADMIN_PW//:/\\:}"

   printf '%s:%s:%s:%s:%s\n' "localhost" "5432" "verirelease_prod" "admin_user" "$ESCAPED_ADMIN_PW" > "$ADMIN_PGPASS"
   ```

3. **Authentication via `PGPASSFILE`**:
   Execute `psql` with `PGPASSFILE="$ADMIN_PGPASS"`. PostgreSQL verifies that the file permissions are exactly `0600` (or more restrictive). If permissions allow group or other access, PostgreSQL rejects the file and prompts for a password.

### B. Environment Variable Mechanics, Limitations & Secret Injection

#### 1. Shell Variables vs. Process Environment
In Unix shells, an assignment like `VAR=value` creates an unexported shell variable. It exists only within the shell interpreter's internal memory and is **not** present in the process environment (`environ`) of spawned child processes.

`psql`'s `\getenv psql_var ENV_VAR` uses the C runtime library function `getenv(3)`, which searches the child `psql` process environment table. Calling `\getenv` against an unexported shell variable returns an empty/null value.

#### 2. The `/proc/<pid>/environ` Exposure Trade-Off
Using `export VAR=value` places the secret into the shell process environment, making it inheritable by child processes. However:
- Any process running under the same UID (or root) on the host can inspect `/proc/<pid>/environ` of the shell or any child process while it is running.
- Exported variables persist in the interactive shell session until explicitly unset, and are inadvertently inherited by subsequent commands.

To balance secret delivery and exposure risk, two working patterns are supported:

#### Pattern 1: Invocation-Scoped Environment Variables (for `\getenv`)
If using `\getenv`, pass environment variables explicitly on the command invocation line:
```bash
DEPLOYER_PW=$(get_secret "verirelease/deployer_password")
APP_PW=$(get_secret "verirelease/app_user_password")

# Variables are scoped strictly to the child psql process environment without polluting the shell
DEPLOYER_DB_PASSWORD="$DEPLOYER_PW" \
APP_DB_PASSWORD="$APP_PW" \
PGPASSFILE="$ADMIN_PGPASS" \
psql -h localhost -p 5432 -U admin_user -d verirelease_prod << 'EOF'
\getenv deployer_pw DEPLOYER_DB_PASSWORD
\getenv app_pw APP_DB_PASSWORD
\o /dev/null
SELECT set_config('verirelease.deployer_password', :'deployer_pw', false);
SELECT set_config('verirelease.app_user_password', :'app_pw', false);
\o
\i scripts/provision-database-roles.sql
EOF

unset DEPLOYER_PW APP_PW
```
*Trade-off*: The secrets are accessible via `/proc/<psql_pid>/environ` strictly for the lifetime of `psql`, but do not persist in the parent shell.

#### Pattern 2: Secure Temporary Credential File (eliminates `/proc` exposure)
To avoid `/proc/<pid>/environ` exposure entirely, write parameters to a secure, temporary file created with `mktemp` and restricted to `0600`:
```bash
PARAM_FILE=$(mktemp)
chmod 0600 "$PARAM_FILE"
trap 'rm -f "$ADMIN_PGPASS" "$PARAM_FILE"' EXIT

# Safely parameterize using PostgreSQL dollar quoting ($sec$...$sec$), handling arbitrary quotes and semicolons
cat << PARAM_EOF > "$PARAM_FILE"
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('verirelease.deployer_password', \$sec\$$(get_secret "verirelease/deployer_password")\$sec\$, false);
SELECT set_config('verirelease.app_user_password', \$sec\$$(get_secret "verirelease/app_user_password")\$sec\$, false);
\o
PARAM_EOF

PGPASSFILE="$ADMIN_PGPASS" psql -h localhost -p 5432 -U admin_user -d verirelease_prod \
  -f "$PARAM_FILE" \
  -f scripts/provision-database-roles.sql

rm -f "$PARAM_FILE"
```

In `scripts/provision-database-roles.sql`, `format('%L', ...)` safely quotes the session parameters as SQL literals, protecting against SQL injection regardless of characters in the password. Passwords are encrypted as `SCRAM-SHA-256` in `pg_authid`.

### C. Credential Rotation Procedures

Rotation for `verirelease_deployer` and `verirelease_app_user` is executed independently:

#### 1. Rotating `verirelease_deployer` Credentials
```bash
ADMIN_PGPASS=$(mktemp)
ROT_FILE=$(mktemp)
chmod 0600 "$ADMIN_PGPASS" "$ROT_FILE"
trap 'rm -f "$ADMIN_PGPASS" "$ROT_FILE"' EXIT

# Populate admin credential in PGPASSFILE
ESCAPED_ADMIN_PW="${ADMIN_PASSWORD//\\/\\\\}"
ESCAPED_ADMIN_PW="${ESCAPED_ADMIN_PW//:/\\:}"
printf '%s:%s:%s:%s:%s\n' "localhost" "5432" "verirelease_prod" "admin_user" "$ESCAPED_ADMIN_PW" > "$ADMIN_PGPASS"

# Write rotation parameter file with dollar quoting
cat << ROT_EOF > "$ROT_FILE"
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('verirelease.deployer_password', \$sec\$$(get_secret "verirelease/new_deployer_password")\$sec\$, false);
\o
DO \$\$
DECLARE
  v_pw TEXT := current_setting('verirelease.deployer_password', true);
BEGIN
  IF v_pw IS NOT NULL AND v_pw <> '' THEN
    EXECUTE format('ALTER ROLE verirelease_deployer WITH PASSWORD %L', v_pw);
  END IF;
END
\$\$;
ROT_EOF

PGPASSFILE="$ADMIN_PGPASS" psql -h localhost -p 5432 -U admin_user -d verirelease_prod -f "$ROT_FILE"
rm -f "$ADMIN_PGPASS" "$ROT_FILE"
```
Update the CI/CD deployment pipeline secret (`MIGRATION_DATABASE_URL`).

#### 2. Rotating `verirelease_app_user` Credentials
```bash
ADMIN_PGPASS=$(mktemp)
ROT_FILE=$(mktemp)
chmod 0600 "$ADMIN_PGPASS" "$ROT_FILE"
trap 'rm -f "$ADMIN_PGPASS" "$ROT_FILE"' EXIT

# Populate admin credential in PGPASSFILE
ESCAPED_ADMIN_PW="${ADMIN_PASSWORD//\\/\\\\}"
ESCAPED_ADMIN_PW="${ESCAPED_ADMIN_PW//:/\\:}"
printf '%s:%s:%s:%s:%s\n' "localhost" "5432" "verirelease_prod" "admin_user" "$ESCAPED_ADMIN_PW" > "$ADMIN_PGPASS"

# Write rotation parameter file with dollar quoting
cat << ROT_EOF > "$ROT_FILE"
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('verirelease.app_user_password', \$sec\$$(get_secret "verirelease/new_app_user_password")\$sec\$, false);
\o
DO \$\$
DECLARE
  v_pw TEXT := current_setting('verirelease.app_user_password', true);
BEGIN
  IF v_pw IS NOT NULL AND v_pw <> '' THEN
    EXECUTE format('ALTER ROLE verirelease_app_user WITH PASSWORD %L', v_pw);
  END IF;
END
\$\$;
ROT_EOF

PGPASSFILE="$ADMIN_PGPASS" psql -h localhost -p 5432 -U admin_user -d verirelease_prod -f "$ROT_FILE"
rm -f "$ADMIN_PGPASS" "$ROT_FILE"
```
Update application secret manager secret (`DATABASE_URL`) and perform a rolling restart of application containers to refresh connection pool authentication.

---

## 5. Defense-in-Depth Mechanisms

### A. Non-Superuser Schema Ownership
The schema and domain tables are owned by `verirelease_owner_role`, not the PostgreSQL superuser (`postgres`).

### B. Trigger Protection Against Runtime Tampering
In PostgreSQL, altering or disabling triggers (`ALTER TABLE ... DISABLE TRIGGER`) requires table ownership or superuser status. Because `verirelease_app_user` does not own any tables and is not a member of `verirelease_owner_role`, any application-level attempt to disable or bypass triggers is rejected at the database level (`42501`).

### C. Layered Protection for Immutable and State-Restricted Tables
1. **Strictly Append-Only Tables (`AuditLog`, `MilestoneSubmission`, `AcceptanceCriterion`):**
   - Privileges `UPDATE`, `DELETE`, and `TRUNCATE` are explicitly revoked from `verirelease_app_user`.
   - Triggers `trg_audit_log_immutable`, `trg_submission_immutable`, and `trg_criteria_immutable` raise SQLSTATE `55000` on any `UPDATE` or `DELETE`, preventing modification during normal DML execution.
2. **Policy Evaluations (`PolicyEvaluation`):**
   - `verirelease_app_user` is granted `SELECT`, `INSERT`, and `UPDATE`.
   - `DELETE` and `TRUNCATE` are explicitly revoked from `verirelease_app_user`.
   - In-progress evaluations can be updated to record criteria evaluations and transition status to `COMPLETED` or `FAILED`.
   - Database trigger `trg_policy_eval_immutable` enforces that once status is `COMPLETED`, all subsequent `UPDATE` operations are blocked with SQLSTATE `55000`. Deletion of any evaluation is permanently prohibited by both privilege revocation (`42501`) and the trigger (`55000`).
3. **Migration Evidence Table (`_migration_execution_context`):**
   - All permissions (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`) are explicitly revoked from `verirelease_app_user` (`42501`).
   - Trigger `trg_migration_context_immutable` raises SQLSTATE `55000` on any `UPDATE` or `DELETE`.

### D. Table Owner and Superuser Operational Boundary
Ordinary PostgreSQL triggers and table privileges enforce immutability strictly against **application runtime roles** (`verirelease_app_user`) and protect against accidental modifications during normal DML operations. They do **not** provide cryptographic or tamper-proof guarantees against table owners or superusers:
- In PostgreSQL, table owners (`verirelease_owner_role`) possess intrinsic DDL authority to alter tables, drop triggers, or disable triggers (`ALTER TABLE ... DISABLE TRIGGER`).
- Superusers (`postgres`) possess additional bypass capabilities, such as setting `session_replication_role = replica` or modifying system catalogs directly.

Consequently, `verirelease_owner_role`, `verirelease_deployer`, and cluster superusers constitute a trusted administrative and operational boundary. Protection against privileged insider actions must be achieved through operational and infrastructure controls, including:
1. Restricting and auditing CI/CD deployment pipeline credentials.
2. Storing deployment keys in secure hardware or dedicated secret managers with approval workflows.
3. Database query auditing (e.g. `pgaudit`) recording all DDL statements.
4. Continuous off-site replication of WAL logs and audit entries to append-only, write-once-read-many (WORM) storage.


---

## 6. End-to-End Migration & Verification Flow

1. **Step 1: Role Provisioning**
   Connect as cluster administrator and execute `scripts/provision-database-roles.sql` using the stdin heredoc pattern.
2. **Step 2: Migration Execution**
   Connect using `MIGRATION_DATABASE_URL` (as `verirelease_deployer`). The session automatically operates with `current_user = verirelease_owner_role`. Apply `prisma/migrations/20261105000000_init/migration.sql`.
3. **Step 3: Runtime Operations**
   Application web servers and background workers connect using `DATABASE_URL` (as `verirelease_app_user`).
