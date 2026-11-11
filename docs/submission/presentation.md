# VeriRelease — Hackathon Presentation Deck (9 Slides)

**Event:** PayPal AI Hackathon 2026  
**Project:** VeriRelease — Verifiable AI Milestone Verification & PayPal Payout Authorization  
**Repository:** https://github.com/Karmansingh09/VeriRelease  

---

## Slide 1: Title & Core Thesis
**VeriRelease**  
*AI evaluates evidence; deterministic logic authorizes; PayPal settles.*

- Bridging software engineering contracts, GitHub Pull Requests, and PayPal Sandbox payouts with tamper-evident verification receipts.
- **Strict Trust Boundary:** VeriRelease is a verification & authorization coordinator — **never** an escrow custodian.

---

## Slide 2: The Problem
Software milestone contracts break down at two points:
1. **Verification Friction:** Non-technical clients struggle to manually audit GitHub commits, PR diffs, and CI test logs.
2. **Payment & Trust Risk:** Developers suffer delayed approvals, while giving an LLM autonomous access to financial APIs introduces unacceptable prompt-injection and hallucination risks.

---

## Slide 3: The VeriRelease Solution
A 5-stage verifiable workflow separating **evidence harvesting**, **AI reasoning**, **deterministic authorization**, and **idempotent settlement**:
1. **Define & Fund:** Client creates a contract, defines structured acceptance criteria (`AUTOMATED_TEST`, `FILE_CHANGE`, `CODE_QUALITY`, `SPECIFICATION`, `MANUAL_APPROVAL`), and funds the milestone (`DRAFT -> FUNDED`).
2. **Submit PR:** Assigned developer links a GitHub Pull Request (`PR #`, 40-char commit SHA, URL), freezing criteria into an immutable SHA-256 snapshot.
3. **Harvest Evidence:** Collects commits, PR metadata, and CI check runs into canonical RFC 8785 JSON (`GitHubEvidenceSnapshot`).
4. **Evaluate & Decide:** AI assesses criteria as **untrusted candidate input**. Only the pure **Deterministic Policy Engine** can authorize `ELIGIBLE_FOR_PAYOUT`.
5. **PayPal Sandbox Settlement:** Authorized Client triggers idempotent PayPal Orders v2 capture backed by PostgreSQL row locks.

---

## Slide 4: Architecture & Non-Negotiable Security Boundaries
```
[ Developer PR ] ─▶ [ GitHub Evidence Snapshot (RFC 8785 SHA-256) ]
                             │
                             ▼
                  [ AI Evaluator (OpenAI / Demo AI) ]  <-- Untrusted Input Only
                             │
                             ▼
              [ Deterministic Policy Engine ]          <-- Authoritative Verdict
                             │
                             ▼ (ELIGIBLE_FOR_PAYOUT)
              [ PayPal Sandbox Coordinator ]           <-- PostgreSQL Locks + PayPal-Request-Id
```
- **Zero Financial Authority for AI:** AI never sees PayPal credentials, never chooses amounts, and never triggers payment endpoints.
- **No Blind Retries:** PayPal timeouts or 5xx responses transition immediately to `PAYOUT_UNCERTAIN` for operator reconciliation instead of risking double-charges.

---

## Slide 5: GitHub Integration & Identity Security (M3 & M3.1)
- **GitHub OAuth 2.0 Web Flow + RFC 7636 PKCE (`S256`):** Server-side confidential `OAuthTransaction` store with single-use atomic consumption.
- **Canonical-Origin CSRF Protection:** Validates `Origin`, `Referer`, and `Sec-Fetch-Site` on all cookie-authenticated mutations.
- **HMAC-SHA256 Webhook Verification:** Constant-time signature checks on incoming GitHub webhook deliveries with PostgreSQL concurrency deduplication.

---

## Slide 6: PayPal Sandbox Settlement & Money Safety (M2 & M6)
- **Authoritative Integer Minor Units:** All monetary amounts use PostgreSQL `BIGINT` minor units (`$500.00 = 50000n`); frontend amounts are completely ignored.
- **Three-Phase Execution:** Database `FOR UPDATE` locks and `RESERVED -> PROCESSING` transitions prevent holding locks across external PayPal HTTP calls.
- **Double-Payout Immunity:** Partial unique PostgreSQL index blocks duplicate `SUCCEEDED` transactions per milestone + deterministic `PayPal-Request-Id` idempotency keys.

---

## Slide 7: Live Product Experience (M7)
- **Workspace Dashboard (`/dashboard`):** Role-aware contract management, KPI overview, and 1-click Demo Contract seeder.
- **Contract Builder (`/contracts/[id]`):** GitHub repository verification and multi-type acceptance criteria builder.
- **Milestone Verification Workbench (`/milestones/[id]`):** Interactive lifecycle stepper, PR submission form, AI + Policy verdict breakdown, RFC 8785 SHA-256 hashes, PayPal Sandbox payout trigger, and append-only audit timeline.

---

## Slide 8: Verification & Test Proof
- **Complete Automated Test Suite:** 555 passing unit & live PostgreSQL integration tests across 40 test files (125 PostgreSQL integration, 430 unit) covering:
  - Database constraints, row locks, and partial unique indexes
  - Payment reservation, idempotency, and `PAYOUT_UNCERTAIN` reconciliation
  - OAuth PKCE confidentiality, CSRF, and GitHub webhook concurrency
  - Missing CI evidence, failed checks, OpenAI fallback, unauthorized actors, and full end-to-end PayPal flow
- **Clean Static Checks:** Strict TypeScript (`tsc --noEmit`), ESLint, Prisma schema validation, and Next.js production build.

---

## Slide 9: Future Roadmap
- Live PayPal Payouts Batch API & Webhook reconciliation worker for asynchronous clearing.
- Multi-milestone batch funding & GitHub PR inline comment bot summarizing deterministic policy receipts.
- Organization multi-approver governance for enterprise software procurement.
