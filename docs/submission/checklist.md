# VeriRelease — Hackathon Submission Checklist & Verification Disclosures

## 1. Completed Engineering Deliverables
- [x] **M1 & M2:** PostgreSQL Prisma schema, state machines, canonical RFC 8785 hashing, append-only audit ledger, deterministic policy engine, three-phase payment reservation, idempotency, and reconciliation state machine (`f0cef45`).
- [x] **M3 & M3.1:** GitHub App repository verification, HMAC webhook ingestion & concurrency protection, RFC 7636 PKCE GitHub OAuth 2.0 flow, `HttpOnly` signed sessions, and canonical-origin CSRF protection (`a262ab5`).
- [x] **M4:** Contract & Milestone Lifecycle Service and REST API routes (`b70299c`).
- [x] **M5:** Normalized GitHub evidence pipeline + OpenAI & Demo AI evaluator + deterministic policy integration (`02da505`).
- [x] **M6:** PayPal Sandbox `RestPayPalClient` + `MockPayPalClient` + `PayoutCoordinator` (`cf72794`).
- [x] **M7:** Complete interactive Next.js frontend (`/`, `/dashboard`, `/contracts/[id]`, `/milestones/[id]`) + demo persona sign-in (`f4a0765`).
- [x] **M8:** Full end-to-end integration matrix (`tests/integration/full-hackathon-e2e.test.ts`), updated `README.md`, presentation deck, demo script, and deployment instructions.

---

## 2. Honest External Integration & Deployment Disclosures
- **External Credentials in Local Sandbox:** No live external `OPENAI_API_KEY`, `GITHUB_OAUTH_CLIENT_ID`/`SECRET`, or `PAYPAL_CLIENT_ID`/`SECRET` are bundled in source control.
  - When live credentials are configured in `.env.local` / deployment environment, VeriRelease invokes real GitHub OAuth 2.0 / REST APIs, real OpenAI `gpt-4o` structured outputs, and real `https://api-m.sandbox.paypal.com` Orders v2 capture endpoints (`RestPayPalClient`).
  - When placeholder values are present in local/demo environments, adapters fall back honestly to `DemoAiProvider` (`isDemoMode: true`) and `MockPayPalClient` (`mode: "mock"`), surfaced transparently in UI badges and API payloads.
- **Deployment & Media Artifacts:**
  - Production deployment instructions for Vercel + managed PostgreSQL (`prisma migrate deploy`) are documented in `README.md`. No live public deployment URL is claimed or fabricated here.
  - A step-by-step storyboard & 4-minute narration script is provided in `docs/submission/demo-script.md`; no pre-recorded video artifact was generated in this repository.
