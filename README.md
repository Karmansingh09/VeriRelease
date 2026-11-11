# VeriRelease

> **AI-assisted milestone verification and PayPal payout authorization platform for software development contracts.**
> *Built for the PayPal AI Hackathon 2026.*

---

## 1. Product Overview & Core Architectural Principle

In freelance and enterprise engineering contracts, milestone approvals often stall between manual code audits and payment trust gaps. **VeriRelease** connects GitHub Pull Requests, automated CI checks, AI evidence evaluation, deterministic policy receipts, and idempotent PayPal Sandbox payouts into a single verifiable workflow:

```
[1. Client Contract & Funded Milestone]
                 │
                 ▼
[2. Developer Submits GitHub PR + Commit SHA] ──▶ Freezes Criteria Hash (SHA-256)
                 │
                 ▼
[3. GitHub Evidence Snapshot (RFC 8785)]      ──▶ Commits, PR State & CI Checks
                 │
                 ▼
[4. AI Evidence Evaluator (Untrusted Input)]  ──▶ Candidate Criterion Assessments
                 │
                 ▼
[5. Deterministic Policy Engine]              ──▶ ELIGIBLE_FOR_PAYOUT (+ Receipt Hash)
                 │
                 ▼
[6. PayPal Sandbox Payout Coordinator]        ──▶ Row Locks + PayPal-Request-Id Capture
```

### Non-Negotiable Principle
> **AI evaluates evidence; deterministic logic authorizes; PayPal executes payment.**

- **AI has zero financial authority:** OpenAI / Demo AI assessments are strictly untrusted inputs evaluated by pure deterministic business logic (`PolicyEvaluationService`).
- **Not an escrow provider:** VeriRelease coordinates verification and PayPal payment authorization. It never custodies funds.
- **`ELIGIBLE_FOR_PAYOUT` ≠ Executed Payment:** Policy eligibility only enables an authorized contract client to trigger PayPal settlement.

---

## 2. Key Features

- **Role-Based Contract & Milestone Lifecycle:** Clients create contracts, define structured acceptance criteria (`AUTOMATED_TEST`, `FILE_CHANGE`, `CODE_QUALITY`, `SPECIFICATION`, `MANUAL_APPROVAL`), fund milestones, request revisions, and release payouts. Developers submit GitHub PRs and track settlements.
- **Verified Identity & Security:** GitHub OAuth 2.0 Web Application Flow with RFC 7636 PKCE (`S256`), confidential server-side `OAuthTransaction` store, signed `HttpOnly` session cookies (`vr_session`), and canonical-origin CSRF defense.
- **Tamper-Evident Receipts:** Canonical RFC 8785 JSON serialization with SHA-256 digests (`criteriaHash`, `evidenceHash`, `receiptHash`) and an append-only PostgreSQL `AuditLog`.
- **PayPal Sandbox Idempotency & Reconciliation:** Authoritative `BIGINT` minor-unit amounts read exclusively from PostgreSQL, `FOR UPDATE` row locks, partial unique index preventing duplicate `SUCCEEDED` payouts per milestone, `PayPal-Request-Id` provider idempotency, and safe `PAYOUT_UNCERTAIN` handling on timeouts/5xx without blind retries.
- **Interactive Next.js Workspace:**
  - `/` — Overview & trust architecture
  - `/dashboard` — Role-aware workspace, KPI summary, Contract Creator, and **1-Click Demo Contract** seeder
  - `/contracts/[id]` — GitHub App verification, milestone & criteria builder, and client funding
  - `/milestones/[id]` — Interactive verification workbench, PR submission, AI + Policy verdict cards, PayPal settlement ledger, and audit timeline

---

## 3. Technology Stack

- **Framework:** Next.js 15 (App Router, React 19)
- **Language:** TypeScript (Strict Mode)
- **Styling:** Tailwind CSS
- **Database & ORM:** PostgreSQL + Prisma 6 (`prisma/schema.prisma`, `prisma/migrations/`)
- **Validation:** Zod 3
- **Testing:** Vitest (Unit & Live PostgreSQL Integration Suites)
- **Integrations:** GitHub OAuth 2.0 + GitHub REST/Webhooks, OpenAI API (`gpt-4o`) + `DemoAiProvider`, PayPal Sandbox Orders v2 (`RestPayPalClient` + `MockPayPalClient`)

---

## 4. Local Development Setup

### Prerequisites
- **Node.js:** v20+
- **PostgreSQL:** PostgreSQL 16+ (or Docker Compose via `docker compose up -d`)

### Step 1: Clone & Configure Environment
```bash
git clone https://github.com/Karmansingh09/VeriRelease.git
cd VeriRelease
cp .env.example .env.local
```
Edit `.env.local` with your PostgreSQL `DATABASE_URL` and secrets (development defaults work automatically for local `NODE_ENV=development` testing).

### Step 2: Install Dependencies & Apply Migrations
```bash
npm install
npx prisma generate
npx prisma migrate deploy
```

### Step 3: Start Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) and click **Launch Interactive Workspace**.
When live GitHub OAuth credentials are not configured locally, the sign-in gate exposes **Hackathon Sandbox Demo Personas** (**Alice Chen — Client** and **Bob Rivera — Developer**) so you can run the full lifecycle in two clicks.

---

## 5. Environment Variable Reference

| Variable | Required in Prod | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | Yes (`production`) | Enables strict production validation and HTTPS enforcement |
| `NEXT_PUBLIC_APP_URL` | Yes (`https://...`) | Canonical origin used for CSRF validation & redirects |
| `DATABASE_URL` | Yes | PostgreSQL connection string (`postgresql://...`) |
| `AUTH_TOKEN_SIGNING_SECRET` | Yes (>=32 chars) | Dedicated HMAC key for `vr_session` tokens |
| `GITHUB_WEBHOOK_SECRET` | Yes (>=16 chars) | Secret for verifying GitHub `x-hub-signature-256` webhooks |
| `GITHUB_OAUTH_CLIENT_ID` / `SECRET` | Yes | GitHub OAuth 2.0 Web Flow credentials |
| `GITHUB_OAUTH_CALLBACK_URL` | Yes (`https://...`) | OAuth redirect URI (`/api/auth/github/callback`) |
| `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` | Yes in prod | GitHub App installation token generation |
| `GITHUB_ACCESS_TOKEN` | Optional (dev) | Personal access token fallback in local dev |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Yes in prod | OpenAI evaluation key (falls back to `DemoAiProvider` in dev) |
| `PAYPAL_MODE` / `PAYPAL_BASE_URL` | Yes (`sandbox`) | Targets `https://api-m.sandbox.paypal.com` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Yes | PayPal Sandbox REST OAuth2 client credentials (`MockPayPalClient` used if placeholders in dev) |
| `PAYPAL_WEBHOOK_ID` | Yes in prod | PayPal webhook signature verification ID |
| `ENABLE_DEMO_AUTH` | Optional | Set `"true"` only for hosted hackathon demo previews without live OAuth |

---

## 6. External Service Setup Guides

### GitHub OAuth & Webhook
1. Create a GitHub OAuth App (`Settings -> Developer settings -> OAuth Apps`) with callback URL `<APP_URL>/api/auth/github/callback`. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
2. Create a GitHub App with read permissions for **Pull Requests**, **Checks**, and **Contents**, install it on target repositories, and configure `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` (PEM).
3. Configure repository webhooks pointing to `<APP_URL>/api/webhooks/github` (`application/json`) using `GITHUB_WEBHOOK_SECRET`.

### OpenAI Evaluator
- Provide a valid `OPENAI_API_KEY` (`sk-...`). Without one (or if the OpenAI request fails), VeriRelease transparently falls back to `DemoAiProvider` (`isDemoMode: true`), which deterministically evaluates normalized GitHub evidence without ever fabricating passing CI checks.

### PayPal Sandbox
1. Create a Sandbox REST App at [developer.paypal.com](https://developer.paypal.com/).
2. Copy Sandbox **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` with `PAYPAL_MODE=sandbox` and `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`.
3. In offline/placeholder environments, VeriRelease selects `MockPayPalClient` (`isDemoMode: true`, generating `ord_sbx_*` / `cap_sbx_*` IDs) while enforcing identical database locks, state transitions, and amount checks.

---

## 7. Running Tests & Verification

```bash
# Strict TypeScript compilation check
npm run typecheck

# ESLint check
npm run lint

# Production Next.js build
npm run build

# Complete Unit + Live PostgreSQL Integration Suite
npm test -- --test-timeout=15000
```

---

## 8. Production Deployment Guide (Vercel + Managed PostgreSQL)

1. Provision a PostgreSQL 16+ database (e.g., Neon, Supabase, or AWS RDS).
2. Run database migrations against the production database:
   ```bash
   DATABASE_URL="postgresql://..." npx prisma migrate deploy
   ```
3. Deploy Next.js to Vercel (or Docker/Node host) and set all required production environment variables from Section 5 with real secrets and `NODE_ENV=production`.
4. Ensure `NEXT_PUBLIC_APP_URL` and `GITHUB_OAUTH_CALLBACK_URL` use `https://` matching your deployed domain.

---

## 9. Security Boundaries & Known Limitations

- **Honest Mode Disclosures:** Demo/mock adapters (`DemoAiProvider`, `MockPayPalClient`, Demo Personas) are clearly marked in API responses (`isDemoMode: true`) and UI badges so judges and operators can immediately distinguish live external calls from local sandbox simulations.
- **PayPal Settlement Scope:** Current implementation uses PayPal REST v2 Orders (`createOrder` + `captureOrder` with `PayPal-Request-Id`). Live asynchronous PayPal webhook ingestion and multi-party PayPal Payouts Batch reconciliation are modeled in `PaymentReconciliation` and targeted for post-hackathon expansion.

---

## 10. Submission Documents

- [Presentation Deck (`docs/submission/presentation.md`)](docs/submission/presentation.md)
- [4-Minute Demo Script (`docs/submission/demo-script.md`)](docs/submission/demo-script.md)
- [Verification Checklist (`docs/submission/checklist.md`)](docs/submission/checklist.md)
- [Implementation Tracker (`docs/hackathon-progress.md`)](docs/hackathon-progress.md)
