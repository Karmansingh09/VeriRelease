# VeriRelease

> **AI-assisted milestone verification and payment authorization platform for software development contracts.**  
> *Developed for the PayPal AI Hackathon 2026.*

---

## 1. Product Vision & Core Principle

In freelance and enterprise software development contracts, milestone approval often leads to friction: clients lack the bandwidth or technical depth to audit code commits, while developers face payment delays despite satisfying agreed deliverables.

**VeriRelease** bridges this gap by introducing an automated, verifiable verification and payment authorization pipeline:

```
[Client Milestone] ──▶ [GitHub PR Submitted] ──▶ [Evidence Harvester]
                                                           │
                                                           ▼
[PayPal Payout] ◀── [Deterministic Policy Engine] ◀── [AI Evidence Evaluator]
        │                       │
        ▼                       ▼
  [Disbursement]      [Tamper-Evident Receipt]
```

### The VeriRelease Core Principle:
> **AI evaluates evidence; deterministic application logic authorizes payment; PayPal executes payment.**

The AI model strictly operates in a read-only advisory capacity. It extracts and scores evidence against acceptance criteria, but possesses **zero execution credentials, API keys, or autonomous authorization to disburse funds**.

> [!NOTE]
> **Legal & Financial Boundary:** VeriRelease is an automated milestone verification and payment authorization coordinator. It is **not** an escrow provider, bank, or financial custodian. All payment movements are authorized and executed directly via PayPal Sandbox accounts.

---

## 2. Key Differentiator: Verifiable Evidence Receipts

Every completed verification generates a machine-readable, canonical **Evidence Receipt**:

* **Contract & Milestone Identifiers:** Permanent database IDs and milestone sequencing.
* **Acceptance Criteria Version:** Exact criteria snapshot evaluated during the run.
* **GitHub Audit Anchor:** Repository, PR number, and immutable Git commit SHA.
* **Evidence Citations:** File paths, line numbers, test suite outputs, and CI status checks.
* **Evaluations:** Explicit per-criterion outcome (`PASS`, `FAIL`, or `INSUFFICIENT_EVIDENCE`).
* **Cryptographic Data Integrity Hash:** A SHA-256 digest computed over the RFC 8785 canonical JSON payload.
* **Policy Verdict:** Final deterministic determination (`APPROVED`, `REJECTED`, or `REQUIRES_MANUAL_REVIEW`).

### Cryptographic Precision
SHA-256 hashes in VeriRelease demonstrate **integrity and non-repudiation of the recorded verification data**. A valid receipt hash proves that the recorded findings, commit SHAs, and criteria have not been modified after issuance. A cryptographic hash does not prove that code is defect-free or that the developer did not manipulate external dependencies.

---

## 3. Technology Stack

* **Framework:** [Next.js 15](https://nextjs.org/) (App Router, React 19, Server Components)
* **Language & Typing:** TypeScript (Strict Mode, `noImplicitAny`, `noUncheckedIndexedAccess`)
* **Styling & Components:** Tailwind CSS, Radix UI primitives
* **Database & ORM:** PostgreSQL 16 (Docker Compose), Prisma ORM
* **Runtime Validation:** Zod 3 (Strict environment and payload schema validation)
* **Test Harness:** Vitest (Unit & failure scenario tests)
* **External Integrations:**
  * **GitHub REST & Webhooks:** Octokit, HMAC SHA-256 webhook signature verification
  * **OpenAI API:** Structured outputs (`response_format: json_schema`) for evidence correlation
  * **PayPal Sandbox:** REST API v2 Orders & Payouts with strict idempotency keys

---

## 4. Security & Payment-Risk Safeguards

1. **Decoupled Three-Phase Payments:** Database connections and locks are never held open during external PayPal API calls.
2. **Idempotency Invariant:** Unique database constraints on `(milestoneId, status='PAID')` and transaction `idempotencyKey` prevent duplicate payouts under network retries.
3. **No Blind Retries:** If an external payment call experiences a network timeout or 5xx gateway error, the milestone transitions to `PAYOUT_UNCERTAIN` and halts further payment attempts until verified via PayPal reconciliation or webhook.
4. **Webhook Security:** Incoming GitHub webhooks require HMAC SHA-256 signature verification (`x-hub-signature-256`). Incoming PayPal webhooks require certificate and transmission signature validation.
5. **Zero Insecure Defaults:** In production, missing secrets halt application boot immediately via fail-fast Zod validation (`src/lib/env.ts`).

---

## 5. Local Development Setup

### Prerequisites
* **Node.js:** v20+ (v24 recommended)
* **Docker & Docker Compose:** Required for containerized PostgreSQL

### Step 1: Clone & Configure Environment
```bash
# Clone the repository
git clone https://github.com/Karmansingh09/VeriRelease.git
cd VeriRelease

# Create local environment file from template
cp .env.example .env.local
```

### Step 2: Start PostgreSQL Database
```bash
# Launch PostgreSQL 16 container with persistent storage
docker compose up -d

# Verify container health
docker compose ps
```

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Run Type Checks, Linting & Tests
```bash
# Run strict TypeScript compilation check
npm run typecheck

# Run ESLint
npm run lint

# Run Vitest test suite (including failure scenarios)
npm test
```

### Step 5: Start Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 6. Implementation Roadmap

* **[x] Milestone 1: Project Foundation, Tooling & Environment Validation**
* **[ ] Milestone 2: Domain Modeling, State Machine & Append-Only Audit Ledger**
* **[ ] Milestone 3: Contract & Acceptance Criteria Management UI/API**
* **[ ] Milestone 4: GitHub Integration & Evidence Harvester (Webhook & Diff Extractor)**
* **[ ] Milestone 5: AI Evidence Evaluator & Deterministic Policy Engine**
* **[ ] Milestone 6: RFC 8785 Canonical Evidence Receipts & Verification Endpoint**
* **[ ] Milestone 7: PayPal Sandbox Payment Coordination & Reconciliation**
* **[ ] Milestone 8: End-to-End Hardening, Failure Injection Tests & Demonstration**
