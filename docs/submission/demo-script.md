# VeriRelease — 4-Minute Hackathon Demo Script & Storyboard

**Target Runtime:** 3.5 – 4.5 minutes  
**Environment:** Local or deployed Next.js instance (`npm run dev` or production build) with PostgreSQL running.

---

## 0:00 – 0:40 | Scene 1: Landing Page (`/`) & Core Principle
- **Screen:** Open `http://localhost:3000`.
- **Narration:**
  > "Software milestone contracts often stall between unclear manual code reviews and payment risk. This is VeriRelease — an AI-assisted milestone verification and PayPal payout authorization platform. Notice our core architectural rule: AI evaluates evidence, deterministic logic authorizes payment, and PayPal executes settlement. VeriRelease never custodies escrow funds, and the AI never holds financial authority."
- **Action:** Click **Launch Interactive Workspace**.

---

## 0:40 – 1:15 | Scene 2: Session Authentication & 1-Click Demo Setup (`/dashboard`)
- **Screen:** `AuthGate` / Workspace Dashboard.
- **Narration:**
  > "VeriRelease supports full GitHub OAuth 2.0 with server-side PKCE and HttpOnly signed sessions. For this sandbox walkthrough, I'll sign in as Alice Chen, our Demo Client."
- **Action:**
  1. Click **Alice Chen (Client)** on the Hackathon Sandbox Persona card.
  2. Click **+ 1-Click Demo Contract & Funded Milestone** on `/dashboard`.
- **Narration:**
  > "That created a contract targeting Bob Rivera, defined a $500 milestone with three structured acceptance criteria — Automated CI Tests, Code Changes, and Specification Compliance — and funded it from DRAFT to FUNDED."

---

## 1:15 – 2:00 | Scene 3: Developer Delivers GitHub PR (`/milestones/[id]`)
- **Screen:** Milestone Verification Workbench (`/milestones/[id]`).
- **Narration:**
  > "Notice the action workbench enforces strict role boundaries — only the assigned developer can submit deliverables. Let's switch our session to Bob Rivera."
- **Action:**
  1. Click **Act as Developer** in the Action Workbench quick-switch.
  2. Review the prefilled PR #42 and 40-char commit SHA, then click **Submit PR Deliverable**.
- **Narration:**
  > "Submitting the PR freezes the active acceptance criteria into an immutable SHA-256 hash so neither party can silently alter requirements mid-review."

---

## 2:00 – 2:55 | Scene 4: AI Evaluation & Deterministic Policy Engine
- **Screen:** Milestone Verification Workbench (`/milestones/[id]`).
- **Action:** Click **Run AI + Policy Verification**.
- **Narration:**
  > "VeriRelease harvests the normalized PR and CI evidence, asks the AI Evaluator to assess each criterion, and feeds those untrusted candidate results into our pure deterministic Policy Engine. Only the Policy Engine transitions the milestone to ELIGIBLE FOR PAYOUT and issues an RFC 8785 canonical SHA-256 receipt hash."
- **Highlight on Screen:**
  - Point to the per-criterion **PASS** badges and reasoning.
  - Point to the **RFC 8785 Receipt SHA-256** digest.
  - Mention negative edge-case safety: *"If CI checks are missing or failed, the system refuses to fabricate a pass and moves to CHANGES REQUESTED instead."*

---

## 2:55 – 3:45 | Scene 5: PayPal Sandbox Settlement & Audit Trail
- **Screen:** Milestone Verification Workbench (`/milestones/[id]`).
- **Action:**
  1. Click **Act as Client** to return to Alice Chen.
  2. Click **Release $500.00 USD via PayPal**.
- **Narration:**
  > "Now that the milestone is deterministically ELIGIBLE FOR PAYOUT, Alice triggers payment. Behind the scenes, VeriRelease acquires a PostgreSQL FOR UPDATE row lock, derives the authoritative integer minor-unit amount directly from the database, reserves an idempotency key, creates and captures the PayPal Sandbox order, and commits the SUCCEEDED settlement alongside an append-only audit timeline."
- **Highlight on Screen:**
  - Point to **PayPal Settlement Ledger** (`Order ID`, `Capture ID`, `Idempotency Key`).
  - Scroll through the **Audit Timeline** (`MILESTONE_CREATED`, `MILESTONE_FUNDED`, `MILESTONE_SUBMITTED`, `POLICY_EVALUATION_APPROVED`, `PAYMENT_SUCCEEDED`).

---

## 3:45 – 4:00 | Scene 6: Closing
- **Narration:**
  > "VeriRelease gives clients auditable technical confidence and gives developers fast, deterministic payouts — combining AI code analysis with financial-grade PayPal safety. Thank you!"
