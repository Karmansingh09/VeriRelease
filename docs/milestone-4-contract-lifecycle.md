# VeriRelease Milestone 4 — Contract & Milestone Lifecycle API

**Status:** Completed  
**Tests:** 520 passing across 34 test files (113 integration, 407 unit)  

## 1. Overview

Milestone 4 implements the core contract and milestone lifecycle coordination engine and REST API routes for VeriRelease. It bridges the foundational database repositories, deterministic milestone state machine, immutable criteria snapshotting, and append-only audit log with verified client and developer workflows.

---

## 2. Implemented Capabilities

### Client Workflow
- **Contract Creation (`POST /api/contracts`):** Clients create contracts specifying deliverables, budget (`totalAmountMinorUnits` / `totalAmountUsd`), currency, repository (`githubRepoOwner`/`githubRepoName`), and developer assignment (via `developerId`, `developerEmail`, or `developerGithubUsername`).
- **Milestone Creation (`POST /api/contracts/[id]/milestones`):** Clients configure milestone budget and defined acceptance criteria (`AUTOMATED_TEST`, `FILE_CHANGE`, `CODE_QUALITY`, `SPECIFICATION`, `MANUAL_APPROVAL`).
- **Milestone Funding (`POST /api/milestones/[id]/fund`):** Transitions milestone from `DRAFT` to `FUNDED`, requiring at least one active criterion. Automatically activates parent contract (`DRAFT` -> `ACTIVE`).
- **Change Requests (`POST /api/milestones/[id]/request-changes`):** Clients request revisions on submitted work with explicit feedback reasons (`SUBMITTED` / `EVALUATING` -> `CHANGES_REQUESTED`).

### Developer Workflow
- **Contract Discovery (`GET /api/contracts`):** Developers view contracts where they are the assigned party.
- **Work Submission (`POST /api/milestones/[id]/submissions`):** Developers submit pull request deliverables (`prNumber`, `prCommitSha`, `prUrl`). Freezes immutable criteria snapshot with canonical RFC 8785 SHA-256 hash.
- **Resubmission:** After changes are requested, developers resubmit with an updated commit SHA; sequentially increments `submissionNumber`.

### System & Security Invariants
- **Authorization Enforcement:** Only contract clients can add milestones, fund milestones, or request changes. Only assigned developers can submit work deliverables. Third parties receive `403 Forbidden`.
- **Append-Only Audit Logging:** All lifecycle transitions (`CONTRACT_CREATED`, `MILESTONE_CREATED`, `MILESTONE_FUNDED`, `MILESTONE_SUBMITTED`, `CHANGES_REQUESTED`, `MILESTONE_RESUBMITTED`) are transactionally hashed and recorded to PostgreSQL `AuditLog`.
- **CSRF & Bearer Exemption:** All mutating endpoints enforce canonical-origin CSRF defense for browser sessions while permitting Bearer API clients.

---

## 3. Endpoints Implemented

| Method | Path | Description | Protected |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/contracts` | List contracts for authenticated user | Session / Bearer |
| `POST` | `/api/contracts` | Create a new contract | CSRF + Auth |
| `GET` | `/api/contracts/[id]` | Get contract details with milestones | Session / Bearer |
| `GET` | `/api/contracts/[id]/milestones` | List milestones for contract | Session / Bearer |
| `POST` | `/api/contracts/[id]/milestones` | Add milestone with criteria | CSRF + Client Auth |
| `GET` | `/api/milestones/[id]` | Get detailed milestone view | Session / Bearer |
| `POST` | `/api/milestones/[id]/fund` | Fund milestone (`DRAFT` -> `FUNDED`) | CSRF + Client Auth |
| `GET` | `/api/milestones/[id]/submissions`| List submissions for milestone | Session / Bearer |
| `POST` | `/api/milestones/[id]/submissions`| Submit PR deliverable | CSRF + Developer Auth |
| `POST` | `/api/milestones/[id]/request-changes` | Request revisions | CSRF + Client Auth |
| `GET` | `/api/users` | List / search active users | Session / Bearer |
| `PATCH`| `/api/users/role` | Switch active role for demo testing | CSRF + Auth |
