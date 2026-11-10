# VeriRelease Milestone 5 — GitHub Evidence & AI Evaluation Engine

**Status:** Completed  
**Tests:** 531 passing across 36 test files (115 integration, 416 unit)  

## 1. Overview

Milestone 5 implements the automated evidence harvesting and AI-assisted verification engine for VeriRelease. It integrates GitHub pull request, commit, and CI check evidence into the immutable evidence snapshot pipeline, runs structured AI assessment against frozen milestone acceptance criteria, and feeds untrusted AI output through the pure deterministic policy engine.

---

## 2. Key Architecture & Trust Boundaries

```
[ Developer GitHub PR ]
          │
          ▼
[ GitHub Evidence Service ] ───▶ [ Immutable GitHubEvidenceSnapshot (RFC 8785 Hash) ]
          │
          ▼
[ AI Evaluation Provider ] (OpenAI / Deterministic Demo Provider)
          │
          ▼ Untrusted Candidate Assessments
[ Deterministic Policy Engine ] ───▶ Evaluates against frozen criteria snapshot
          │
          ▼
[ Milestone State Transition ] ───▶ ELIGIBLE_FOR_PAYOUT (or CHANGES_REQUESTED)
          │
    (SECURITY INVARIANT)
  AI and Policy Engine NEVER authorize or execute payments directly!
```

### Architectural Principles:
1. **AI Output Is Untrusted Input:** The AI inspects normalized pull request metadata, commits, changed files, and CI run statuses to produce candidate criterion assessments. It does NOT decide whether money is released.
2. **Deterministic Authority:** Only the pure, deterministic policy engine evaluates candidate assessments against the authoritative database criteria snapshot and decides whether a milestone transitions to `ELIGIBLE_FOR_PAYOUT` or `CHANGES_REQUESTED`.
3. **Payment Separation:** `ELIGIBLE_FOR_PAYOUT` represents verification eligibility only. Zero payment transactions, reservations, or PayPal API calls are executed by the verification engine.
4. **Honest Evidence Enforcement:** The engine strictly forbids fabricating evidence. If CI check runs are unavailable or pending, the AI evaluator fails the automated test criterion and flags the missing evidence.
5. **Provider Resilience:** Supports live OpenAI (`gpt-4o`) with structured JSON schema output and includes a robust `DemoAiProvider` for offline or sandboxed hackathon demonstrations without external API keys.

---

## 3. Endpoints Implemented

| Method | Path | Description | Access Control |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/submissions/[id]/evaluate` | Harvests evidence, runs AI evaluation, and enforces deterministic policy decision | CSRF + Contract Participant Auth |
| `GET` | `/api/submissions/[id]/evaluate` | Returns latest policy evaluation, AI breakdown, and evidence summary | Contract Participant Auth |
