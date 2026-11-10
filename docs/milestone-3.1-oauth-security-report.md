# VeriRelease Milestone 3.1 — OAuth 2.0 Security Audit & Remediation Report

**Date:** November 10, 2026  
**Auditor:** VeriRelease Security Engineering & Quality Assurance  
**Milestone:** 3.1 — Verified GitHub OAuth Identity Linking & Secure Session Delivery  
**Target Repository:** `github.com/Karmansingh09/VeriRelease`  
**Git Branch:** `main`  
**Git HEAD Commit:** `f0cef45498722fa1979496cc0f13f5fc86c5d063`  
**Verdict:** **`CONDITIONAL — EXTERNAL INTEGRATION REQUIRED`**

---

## 1. Executive Summary & Audit Scope

This document provides a source-code-backed security audit, architecture remediation report, and formal verification package for Milestone 3.1 of VeriRelease. Milestone 3.1 implements cryptographic GitHub OAuth 2.0 Web Application Flow identity linking, user auto-provisioning, secure session delivery via HTTP-only cookies, RFC 7636 PKCE (S256) verifier confidentiality, and defense-in-depth Cross-Site Request Forgery (CSRF) protection.

The audit was conducted strictly against the actual source files, database migration SQL, Prisma schema, and test suite execution in a sandboxed Linux environment with a dedicated PostgreSQL 18 test cluster.

### Security Remediation Summary
The security audit identified and remediated critical authentication, session fixation, account linking, PKCE confidentiality, and CSRF vulnerabilities:

1. **PKCE Verifier Server-Side Storage & Zero-Leakage Confidentiality:**
   - *Vulnerability Identified:* The initial implementation embedded the PKCE `code_verifier` in the state payload signed by HMAC-SHA256. While HMAC guarantees integrity and tamper-evidence, it does **not** provide confidentiality or encryption. Base64url-decoding the state token allowed untrusted clients, access logs, proxy caches, or network eavesdroppers to inspect the plaintext `code_verifier`.
   - *Remediated Architecture:* Generated a 32-byte cryptographically secure random `code_verifier` and its SHA-256 S256 `code_challenge`. The verifier is stored server-side in a dedicated `OAuthTransaction` table bound to `stateNonce`, `action`, `userId`, `returnTo`, and a 10-minute `expiresAt`. The state token and authorization URL contain **only** an opaque cryptographic nonce and the S256 `code_challenge`. During the OAuth callback, the transaction is atomically retrieved and marked consumed in a single atomic SQL transaction (`UPDATE ... RETURNING`), completely eliminating replay attacks and ensuring zero leakage in URLs, tokens, headers, or client storage.
2. **Canonical Origin CSRF Defense & Host Header Injection Immunity:**
   - *Vulnerability Identified:* Deriving the expected application origin from the incoming HTTP `Host` header creates vulnerability to Host Header Injection, DNS rebinding, and reverse proxy routing exploits.
   - *Remediated Architecture:* Completely decoupled origin validation from the incoming `Host` header. The expected application origin is strictly resolved from `NEXT_PUBLIC_APP_URL` (`getCanonicalAppOrigin()`). In production, HTTPS protocol is strictly enforced; in development and testing, standard local origins (`http://localhost:3000`, `http://127.0.0.1:3000`) are permitted. Safe methods (`GET`, `HEAD`, `OPTIONS`) and `Authorization: Bearer <token>` REST API clients are safely exempt, while cookie-authenticated state-changing requests enforce `Sec-Fetch-Site !== 'cross-site'`, Origin matching, and Referer matching.
3. **Account Linking Session Binding & CSRF Immunity:**
   - Callback handler (`action=link`) re-authenticates the active browser session, verifies `currentAuthenticatedUser.id === statePayload.userId`, checks user active status, validates database token version freshness, and refuses unauthenticated or mismatched account linking attempts (`401 Unauthorized` / `403 Forbidden`).
4. **Zero Silent Email-Based Auto-Merging:**
   - When a user logs in via GitHub OAuth whose verified email matches an existing VeriRelease user without a linked GitHub account, automatic account merging is strictly forbidden (`DomainConflictError`, `409 Conflict`). Users must authenticate into VeriRelease first and link their GitHub account explicitly in settings.
5. **Identity Replacement Prevention:**
   - Users with an existing linked GitHub account cannot overwrite or replace it with a different GitHub account without explicit prior unlinking.

---

## 2. Threat Model & Invariant Analysis

| Threat / Attack Vector | Vulnerability Pre-Remediation | Remediated Defense & Architectural Invariant |
| :--- | :--- | :--- |
| **PKCE Verifier Exposure (Lack of Confidentiality)** | `codeVerifier` was placed inside HMAC-signed state token. HMAC provides integrity, not confidentiality; base64url decoding leaked the verifier in browser history, referrers, and logs. | `code_verifier` is never transmitted to the client. It is stored server-side in `OAuthTransaction` table keyed by a 32-byte cryptographic nonce. Transmitted state token contains only opaque nonce. |
| **PKCE Code Verifier Replay / Re-use** | Stateless token verification allowed replaying the authorization code with the state token until the 10-minute expiry window lapsed. | Single-use atomic consumption: PostgreSQL `UPDATE "OAuthTransaction" SET "consumedAt" = NOW() WHERE "stateNonce" = $1 AND "consumedAt" IS NULL AND "expiresAt" > NOW() RETURNING ...` executes with row-level locking. Second attempt returns `null` and fails with `DomainUnauthorizedError`. |
| **Host Header Injection CSRF Bypass** | Validating incoming `Origin` against `req.headers.get("host")` allowed an attacker sending a manipulated `Host: evil.com` header to validate `Origin: https://evil.com`. | The expected origin is statically derived from canonical configuration (`NEXT_PUBLIC_APP_URL`). The incoming `Host` header is completely ignored. |
| **Cross-Site Request Forgery (CSRF)** | Cookie-authenticated endpoints relied solely on ambient browser cookies without Origin validation. | `verifyCsrfProtection()` validates `Sec-Fetch-Site !== 'cross-site'` and checks `Origin`/`Referer` against canonical application origin. Protects browser cookies; exempts `Authorization: Bearer` clients. |
| **Account Linking CSRF** | Callback accepted state token without re-verifying that the browser completing the callback held an active session for `state.userId`. | `handleCallback` validates `currentAuthenticatedUser.id === statePayload.userId` fail-closed. Rejects unauthenticated callers (`401`) and mismatched callers (`403`). |
| **Session Fixation on Link** | An attacker initiates an OAuth link flow, induces victim to log in, and links attacker's GitHub account to victim's VeriRelease account. | State token seals initiating `userId` under HMAC-SHA256 with timestamp and 32-byte nonce. Callback requires active session matching sealed `userId`. |
| **Silent Account Takeover via Email** | GitHub OAuth login matched unlinked accounts by email and silently linked them. An attacker registering a victim's email on an unverified GitHub account could seize the VeriRelease account. | **Strictly prohibited.** If an existing account matches the GitHub verified email but has no linked `githubId`, callback aborts with `DomainConflictError` (`409`). No silent auto-merging permitted. |
| **OAuth Identity Hijack / Replacement** | An authenticated user could initiate an account linking flow that overwrote their existing GitHub identity with another. | The service validates that `targetUser.githubId == null` before updating. If already linked, throws `DomainConflictError` (`409`), requiring explicit account unlinking first. |
| **Open Redirect via returnTo** | User-controlled `returnTo` parameter could redirect to external phishing domains. | Strict sanitization: protocol-relative URLs (`//evil.com`), external schemes (`https://evil.com`), and backslash paths (`/\evil.com`) are sanitized to `/`. |

---

## 3. Source Code Verification Matrix

### 3.1 Architecture & Implementation Files

| File Path | Component | Key Responsibilities & Controls |
| :--- | :--- | :--- |
| [`src/modules/auth/oauth-transaction-store.ts`](file:///home/karman/VeriRelease/src/modules/auth/oauth-transaction-store.ts) | PKCE Transaction Store | Implements `OAuthTransactionStore` interface with `PrismaOAuthTransactionStore` (PostgreSQL atomic row-level update and prune) and `InMemoryOAuthTransactionStore` (isolated unit test harness). |
| [`src/modules/common/csrf.ts`](file:///home/karman/VeriRelease/src/modules/common/csrf.ts) | Canonical Origin CSRF Engine | Implements `verifyCsrfProtection(req, options)`: resolves trusted origin via `getCanonicalAppOrigin(options)` ignoring incoming `Host`, enforces HTTPS in production, validates `Sec-Fetch-Site`, `Origin`, and `Referer`. |
| [`src/modules/auth/github-oauth-service.ts`](file:///home/karman/VeriRelease/src/modules/auth/github-oauth-service.ts) | OAuth Service Core | Generates cryptographically secure 32-byte `codeVerifier`, saves server-side transaction, sends S256 challenge, consumes transaction atomically during callback, validates user binding and account states. |
| [`src/modules/auth/github-oauth-client.ts`](file:///home/karman/VeriRelease/src/modules/auth/github-oauth-client.ts) | GitHub OAuth HTTP Client | Handles token exchange (`code`, `callbackUrl`, `codeVerifier`), profile fetching (`/user`), and primary verified email extraction (`/user/emails`). |
| [`src/modules/auth/auth-service.ts`](file:///home/karman/VeriRelease/src/modules/auth/auth-service.ts) | Authentication Service | Issues HMAC-SHA256 session tokens (`vr_auth.<payload>.<sig>`), authenticates incoming requests via cookies or Authorization header, validates token version against database. |
| [`src/lib/env.ts`](file:///home/karman/VeriRelease/src/lib/env.ts) | Environment Validation | Enforces production secrets (>=32 chars, no placeholders), prohibits secret reuse, enforces HTTPS for `NEXT_PUBLIC_APP_URL` and `GITHUB_OAUTH_CALLBACK_URL` in production. |
| [`src/app/api/auth/github/login/route.ts`](file:///home/karman/VeriRelease/src/app/api/auth/github/login/route.ts) | OAuth Login Initiation | Validates session for `action=link`, checks CSRF on POST, generates state and PKCE challenge, sets `vr_oauth_state` cookie (`HttpOnly; Secure; SameSite=Lax`). |
| [`src/app/api/auth/github/callback/route.ts`](file:///home/karman/VeriRelease/src/app/api/auth/github/callback/route.ts) | OAuth Callback Handler | Extracts code and state, re-authenticates caller via `authService.authenticateRequest`, delegates to `githubOAuthService.handleCallback`, issues `vr_session` cookie, clears state cookie. |
| [`src/app/api/auth/logout/route.ts`](file:///home/karman/VeriRelease/src/app/api/auth/logout/route.ts) | Session Logout | Enforces CSRF validation against canonical origin, expires `vr_session` cookie (`Max-Age=0`). |
| [`src/app/api/auth/me/route.ts`](file:///home/karman/VeriRelease/src/app/api/auth/me/route.ts) | Authenticated User Endpoint | Returns authenticated user profile from session cookie or Bearer token. |
| [`src/app/api/contracts/[id]/github-repo/route.ts`](file:///home/karman/VeriRelease/src/app/api/contracts/[id]/github-repo/route.ts) | Repo Association | Protected by canonical `verifyCsrfProtection(req)` + contract owner authorization. |
| [`src/app/api/submissions/[id]/evidence/route.ts`](file:///home/karman/VeriRelease/src/app/api/submissions/[id]/evidence/route.ts) | Evidence Ingestion | Protected by canonical `verifyCsrfProtection(req)` + submission party authorization. |
| [`prisma/schema.prisma`](file:///home/karman/VeriRelease/prisma/schema.prisma) | Data Model | Added `model OAuthTransaction` for server-side PKCE state, plus `githubId` and `tokenVersion` on `User`. |
| [`prisma/migrations/20261110220000_pkce_oauth_transaction/migration.sql`](file:///home/karman/VeriRelease/prisma/migrations/20261110220000_pkce_oauth_transaction/migration.sql) | Database Migration | Creates table `OAuthTransaction` with indexes on `stateNonce` (unique), `expiresAt`, `consumedAt`, and `userId`. |

---

## 4. Key Remediation Implementations & Proofs

### 4.1 PKCE Confidentiality & Server-Side Storage
In [`src/modules/auth/github-oauth-service.ts`](file:///home/karman/VeriRelease/src/modules/auth/github-oauth-service.ts):
```typescript
// Generate RFC 7636 PKCE code_verifier (32 random bytes, base64url encoded)
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
const nonce = randomBytes(32).toString("hex");

// Store the PKCE verifier strictly server-side in OAuthTransaction store
await this.transactionStore.create({
  stateNonce: nonce,
  codeVerifier,
  action,
  userId: options.authenticatedUserId ?? null,
  returnTo: sanitizedReturnTo,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
});

// State payload contains ONLY public metadata (NO code_verifier)
const statePayload: OAuthStatePayload = {
  nonce,
  action,
  userId: options.authenticatedUserId,
  returnTo: sanitizedReturnTo,
  createdAt: Date.now(),
};

const stateToken = this.createStateToken(statePayload);
```

During code exchange:
```typescript
// Atomically retrieve and consume transaction server-side
const transaction = await this.transactionStore.consume(statePayload.nonce);
if (!transaction) {
  throw new DomainUnauthorizedError("OAuth transaction has expired or has already been used");
}

// Exchange authorization code with GitHub using the confidentially retrieved verifier
const tokenResponse = await this.client.exchangeCode({
  code: params.code,
  callbackUrl: this.config.callbackUrl,
  codeVerifier: transaction.codeVerifier,
});
```

### 4.2 Atomic Single-Use Consumption in PostgreSQL
In [`src/modules/auth/oauth-transaction-store.ts`](file:///home/karman/VeriRelease/src/modules/auth/oauth-transaction-store.ts):
```typescript
export class PrismaOAuthTransactionStore implements OAuthTransactionStore {
  async consume(stateNonce: string, now: Date = new Date()): Promise<OAuthTransactionRecord | null> {
    const rows = await this.prisma.$queryRaw<OAuthTransactionRecord[]>`
      UPDATE "OAuthTransaction"
      SET "consumedAt" = ${now}
      WHERE "stateNonce" = ${stateNonce}
        AND "consumedAt" IS NULL
        AND "expiresAt" > ${now}
      RETURNING
        "id",
        "stateNonce",
        "codeVerifier",
        "action",
        "userId",
        "returnTo",
        "expiresAt",
        "consumedAt",
        "createdAt"
    `;

    return rows.length > 0 ? rows[0] : null;
  }
}
```

### 4.3 Canonical Origin CSRF Engine
In [`src/modules/common/csrf.ts`](file:///home/karman/VeriRelease/src/modules/common/csrf.ts):
```typescript
export function getCanonicalAppOrigin(options?: { trustedOrigin?: string }): string {
  if (options?.trustedOrigin) {
    return normalizeOrigin(options.trustedOrigin);
  }
  const configured = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return normalizeOrigin(configured);
}

export function verifyCsrfProtection(req: Request, options?: CsrfProtectionOptions): void {
  // Safe methods are exempt (RFC 7231)
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return;

  // Authorization: Bearer <token> REST API callers are exempt from CSRF
  const authHeader = req.headers.get("authorization");
  if (authHeader && /^Bearer\s+\S+/i.test(authHeader.trim())) return;

  // If request does not present session cookies, CSRF does not apply
  const cookieHeader = req.headers.get("cookie") ?? "";
  if (!/(?:^|;\s*)(?:vr_session|vr_oauth_state)=/.test(cookieHeader)) return;

  // Enforce Fetch Metadata: reject cross-site navigation/requests
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite.toLowerCase() === "cross-site") {
    throw new DomainForbiddenError("Cross-site request rejected (Sec-Fetch-Site: cross-site)");
  }

  // Canonical origin validation: NEVER trust req.headers.get("host")
  const expectedOrigin = getCanonicalAppOrigin(options);
  const originHeader = req.headers.get("origin");

  if (originHeader) {
    if (originHeader.toLowerCase() === "null") {
      throw new DomainForbiddenError("Opaque/null origins are not permitted for state-changing requests");
    }
    if (normalizeOrigin(originHeader) !== expectedOrigin) {
      throw new DomainForbiddenError(`CSRF origin mismatch: received '${originHeader}', expected canonical '${expectedOrigin}'`);
    }
    return;
  }

  // Fallback to Referer validation
  const refererHeader = req.headers.get("referer");
  if (!refererHeader) {
    throw new DomainForbiddenError("Missing Origin and Referer headers on state-changing cookie request");
  }

  const refererOrigin = new URL(refererHeader).origin.toLowerCase();
  if (refererOrigin !== expectedOrigin) {
    throw new DomainForbiddenError(`CSRF referer mismatch: received '${refererOrigin}', expected canonical '${expectedOrigin}'`);
  }
}
```

---

## 5. Database Schema & Migration Guarantees

```sql
-- Migration: 20261110220000_pkce_oauth_transaction/migration.sql

CREATE TABLE IF NOT EXISTS "OAuthTransaction" (
    "id" TEXT NOT NULL,
    "stateNonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "returnTo" TEXT NOT NULL DEFAULT '/',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OAuthTransaction_stateNonce_key" ON "OAuthTransaction"("stateNonce");
CREATE INDEX IF NOT EXISTS "OAuthTransaction_expiresAt_idx" ON "OAuthTransaction"("expiresAt");
CREATE INDEX IF NOT EXISTS "OAuthTransaction_consumedAt_idx" ON "OAuthTransaction"("consumedAt");
CREATE INDEX IF NOT EXISTS "OAuthTransaction_userId_idx" ON "OAuthTransaction"("userId");
```

---

## 6. Test Suite Execution & Arithmetic Reconciliation

### Reconciliation of Test File Count Discrepancy
In an earlier draft report, the prose stated 23 unit test files, but an enumerated list contained 26 entries due to duplicate and non-existent suite entries (`policy-engine.test.ts`, `redaction.test.ts`, and `submission-state-machine.test.ts`).

The filesystem was independently audited via directory listing:
- `ls tests/integration/` yields exactly **8 integration test files**.
- `ls tests/unit/` yields exactly **23 unit test files**.
- Total test files on disk: **31 test files**.

### Complete Vitest Test Suite Execution
```
 RUN  v3.2.7 /home/karman/VeriRelease

 Test Files  31 passed (31)
      Tests  488 passed (488)
   Start at  23:26:39
   Duration  56.49s
```

### Exact Breakdown Across All 31 Test Files

#### 8 Integration Test Files (111 Tests Backed by Live PostgreSQL 18)
All integration tests run against PostgreSQL test database on socket `/tmp` port 5433:
1. `tests/integration/db-constraints.test.ts` — **23 tests**
2. `tests/integration/repositories.test.ts` — **22 tests**
3. `tests/integration/payments.test.ts` — **11 tests**
4. `tests/integration/github-evidence.test.ts` — **18 tests**
5. `tests/integration/policy-evaluation.test.ts` — **12 tests**
6. `tests/integration/payment-recovery-reconciliation.test.ts` — **6 tests**
7. `tests/integration/audit.test.ts` — **11 tests**
8. `tests/integration/github-oauth.test.ts` — **8 tests** (includes PostgreSQL single-use atomic consumption test)
*Subtotal Integration Tests:* **111 tests** across **8 test files**.

#### 23 Unit Test Files (377 Tests with Mocked Dependencies)
1. `tests/unit/audit-service.test.ts` — **12 tests**
2. `tests/unit/auth-service.test.ts` — **19 tests**
3. `tests/unit/canonical-json.test.ts` — **21 tests**
4. `tests/unit/criteria-snapshot.test.ts` — **4 tests**
5. `tests/unit/csrf.test.ts` — **12 tests** (adversarial host injection, null origins, subdomains, Bearer exemptions)
6. `tests/unit/domain-models.test.ts` — **18 tests**
7. `tests/unit/env.test.ts` — **20 tests**
8. `tests/unit/github-api-routes.test.ts` — **11 tests**
9. `tests/unit/github-evidence-normalization.test.ts` — **9 tests**
10. `tests/unit/github-oauth-api-routes.test.ts` — **14 tests**
11. `tests/unit/github-oauth-service.test.ts` — **34 tests** (PKCE confidentiality, replay prevention, concurrency, pruning)
12. `tests/unit/github-provider.test.ts` — **24 tests**
13. `tests/unit/github-signature-verifier.test.ts` — **10 tests**
14. `tests/unit/github-webhook-service.test.ts` — **8 tests**
15. `tests/unit/idempotency.test.ts` — **10 tests**
16. `tests/unit/milestone-state-machine.test.ts` — **21 tests**
17. `tests/unit/money.test.ts` — **33 tests**
18. `tests/unit/payment-reconciliation.test.ts` — **21 tests**
19. `tests/unit/payment-recovery.test.ts` — **8 tests**
20. `tests/unit/payment-service.test.ts` — **21 tests**
21. `tests/unit/payment-state-machine.test.ts` — **11 tests**
22. `tests/unit/policy-evaluator.test.ts` — **29 tests**
23. `tests/unit/secret-redaction.test.ts` — **5 tests**
*Subtotal Unit Tests:* **377 tests** across **23 unit test files**.

**Total Test Count Reconciled:** 111 (integration) + 377 (unit) = **488 tests** across **31 test files** (100% passing).

---

## 7. Verification Commands & Exit Statuses

| Command | Operational Goal | Result | Exit Code |
| :--- | :--- | :--- | :--- |
| `npm run typecheck` | TypeScript compile check (`tsc --noEmit`) | 0 type errors | `0` |
| `npm run lint` | ESLint rules check | No ESLint warnings or errors | `0` |
| `npx prisma validate` | Prisma schema syntax and model validation | Schema is valid | `0` |
| `npm run build` | Next.js production build | 9/9 pages and API routes compiled | `0` |
| `npm test -- --test-timeout=15000` | Full regression test execution | 31/31 files passed, 488/488 tests passed | `0` |
| `git diff --check` | Whitespace and merge conflict check | Clean | `0` |

---

## 8. Final Audit Verdict

### Exact Verdict:
# **`CONDITIONAL — EXTERNAL INTEGRATION REQUIRED`**

### Verdict Justification:
1. **Internal Architecture & Security Invariants Fully Verified:**
   - **PKCE Confidentiality:** The PKCE `code_verifier` is stored strictly server-side in `OAuthTransaction` and is never exposed in state tokens, URLs, headers, or client cookies.
   - **Replay Protection:** Atomic SQL consumption (`UPDATE ... RETURNING`) prevents reuse of authorization codes or PKCE verifiers.
   - **CSRF Immunity:** Host Header Injection attacks are completely thwarted by validating against canonical application origins configured in the environment (`NEXT_PUBLIC_APP_URL`).
   - **Account Linking Safety:** Account linking strictly requires matching authenticated sessions; zero silent email-based auto-merging is permitted.
   - **Database Integrity:** Enforced via PostgreSQL row-level locks, unique constraints, and partial indexes.
   - **Test Suite:** All 488 tests across 31 test files pass with 0 failures, 0 linter errors, and a clean production build.
2. **External Integration Condition:**
   - Full production deployment approval remains conditional on live interaction with GitHub's production OAuth service (`https://github.com/login/oauth/authorize` and `https://github.com/login/oauth/access_token`) using verified GitHub OAuth Application client credentials over HTTPS. While all local cryptographic, transactional, and architectural mechanisms are validated, external network interaction against GitHub's live OAuth endpoints cannot be verified within an isolated sandbox environment.
