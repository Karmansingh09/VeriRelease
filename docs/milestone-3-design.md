# VeriRelease Milestone 3: GitHub Integration & Evidence Ingestion
## Technical Architecture, Security & Design Specification

---

## 1. Executive Summary & Objective

**VeriRelease** coordinates milestone verification and payment authorization for software engineering contracts. In Milestone 1 and 2, pure domain models, database security controls, repository transactions, deterministic policy evaluation, transactional audit logging, and payment reservation/reconciliation were implemented and verified.

**Milestone 3** establishes the secure, read-only **GitHub Integration & Evidence Ingestion** layer. It enables VeriRelease to:
1. Associate contracts and milestones with authoritative, verified GitHub repositories using stable numeric GitHub IDs.
2. Ingest GitHub webhook notifications securely using HMAC-SHA256 signature verification over raw request payloads with constant-time comparison.
3. Eliminate duplicate webhook delivery processing through durable delivery tracking and idempotent delivery state machines.
4. Retrieve pull requests, commit metadata, and CI/CD check suites via a strictly read-only provider boundary with zero write privileges.
5. Ingest and normalize GitHub evidence into immutable, versioned evidence snapshots cryptographically bound to specific milestone submissions via composite foreign keys.
6. Record all integration lifecycle events (repository association, webhook verification, deduplication, evidence collection) through the append-only audit system.

### Critical Trust Boundaries:
- **Evidence is Input, Not an Approval**: GitHub evidence (including merged PRs or passing checks) is untrusted input to the downstream policy engine. Merged PRs or successful checks never directly authorize payments or approve milestones.
- **Client Inputs Are Untrusted**: URLs, PR numbers, commit SHAs, and webhook payloads submitted by clients or external callers are treated as untrusted assertions. They are independently verified against GitHub and database constraints.
- **Zero Payment Execution**: Milestone 3 contains zero PayPal API calls, zero real-money movement, and zero payment state mutations outside established M2 payment coordinators.
- **Zero Write Permissions**: The GitHub provider requests only read-only repository, pull request, and commit permissions.
- **Zero Credential Leakage**: Webhook secrets, GitHub access tokens, and authorization headers are never logged, persisted in audit records, or exposed in error messages.

---

## 2. Architecture & Module Decomposition

```
                              ┌──────────────────────────────────────────────┐
                              │            GitHub API & Webhooks             │
                              └──────────────────────┬───────────────────────┘
                                                     │
                             X-Hub-Signature-256     │ X-GitHub-Delivery
                             Raw JSON Body           │ HTTPS REST (Read-Only)
                                                     ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    src/modules/github/                                             │
├────────────────────────────────┬──────────────────────────────────┬────────────────────────────────┤
│       Webhook Ingestion        │         Provider Layer           │       Evidence Ingestion       │
│                                │                                  │                                │
│ • WebhookSignatureVerifier     │ • GitHubProvider (Interface)     │ • GitHubEvidenceService        │
│   (HMAC-SHA256, timingSafe)    │ • FetchGitHubProvider (Adapter)  │ • Normalized Evidence Models   │
│ • WebhookDeliveryService       │ • Rate Limit & Timeout Handling  │ • Canonical JSON Hashing       │
│ • GitHubWebhookDelivery (DB)   │ • Pagination Safety              │ • Scoped Submission Binding    │
│ • Idempotent Deduplication     │ • Error Normalization            │ • GitHubEvidenceSnapshot (DB)  │
└────────────────────────────────┴──────────────────────────────────┴────────────────────────────────┘
                                  │                                  │
                                  │ Audit Logs                       │ Repository Locks
                                  ▼                                  ▼
┌──────────────────────────────────────────────────┐ ┌──────────────────────────────────────────────┐
│           src/modules/audit/                     │ │          src/modules/contracts/              │
│ Append-Only Audit Logger (AuditLog)              │ │ Contract, Milestone & Submission Repos       │
└──────────────────────────────────────────────────┘ └──────────────────────────────────────────────┘
                                  │                                  │
                                  ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       PostgreSQL 18                                                │
│ • GitHubRepository (repoId BIGINT PRIMARY KEY)                                                     │
│ • GitHubWebhookDelivery (deliveryId VARCHAR(64) UNIQUE, status ENUM)                               │
│ • GitHubEvidenceSnapshot (submissionId + version UNIQUE, Composite FK, Immutability Trigger)       │
│ • Role-Based Least Privilege: verirelease_app_user (DML) / verirelease_owner_role (DDL)            │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Specifications

### 3.1 GitHub Provider Interface & Adapter (`src/modules/github/provider/`)

#### Responsibilities:
- Defines an abstract, technology-agnostic interface for read-only GitHub queries.
- Implements `FetchGitHubProvider` using native `fetch` with zero external HTTP client dependencies.
- Enforces strict read-only permissions (`contents:read`, `pull_requests:read`, `checks:read`, `metadata:read`).
- Handles GitHub API pagination, rate-limit headers (`x-ratelimit-remaining`, `x-ratelimit-reset`), transient retry backoff, and timeouts (`AbortController`).
- Normalizes provider responses into strongly typed domain objects (`GitHubRepoMetadata`, `GitHubPullRequestDetails`, `GitHubCommitMetadata`, `GitHubChecksSummary`).

#### Provider Interface Definition:
```typescript
export interface GitHubProvider {
  getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata>;
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequestDetails>;
  getPullRequestCommits(owner: string, repo: string, pullNumber: number, options?: PaginationOptions): Promise<GitHubCommitMetadata[]>;
  getCommit(owner: string, repo: string, ref: string): Promise<GitHubCommitMetadata>;
  getPullRequestChecks(owner: string, repo: string, ref: string): Promise<GitHubChecksSummary>;
}
```

#### Provider Safety Constraints:
1. **Timeout**: Configurable per-request timeout (default 10,000ms).
2. **Pagination Safety**: Fixed maximum page limit (default 10 pages, 100 items/page) to prevent infinite loops on large PRs.
3. **Redaction**: All logging strips `Authorization`, `token`, and secret headers.
4. **Error Mapping**:
   - `404 Not Found` -> `DomainNotFoundError`
   - `401 Unauthorized` / `403 Forbidden` -> `DomainForbiddenError` / `GitHubRateLimitError`
   - `422 Unprocessable` -> `DomainValidationError`
   - `5xx / Network Error` -> `ProviderUnavailableError` (with retry where safe)

---

### 3.2 Repository Authorization & Association (`src/modules/github/repository/`)

#### Responsibilities:
- Associates contracts with authorized GitHub repositories using the GitHub numeric repository ID (`repoId`) as the stable primary identifier, protecting against repository renaming or ownership transfers.
- Validates caller permissions: only authorized contract parties (`clientId`, `developerId`, or `ADMIN`) may link or update repository associations.
- Verifies repository existence and accessibility directly through the GitHub provider before persistence.
- Upserts authoritative `GitHubRepository` records and updates the parent `Contract`.
- Emits structured audit log events (`REPOSITORY_ASSOCIATED`).

#### Association Flow:
1. Caller supplies `contractId`, `owner`, and `repo`.
2. Service verifies caller identity matches `contract.clientId` or `contract.developerId`.
3. Service calls `githubProvider.getRepository(owner, repo)`.
4. Provider verifies access (including private repositories via configured token/installation) and returns `repoMeta.id` (numeric `BigInt`).
5. In a database transaction:
   - Upsert `GitHubRepository` record with authoritative metadata (`repoId`, `owner`, `name`, `fullName`, `isPrivate`, `defaultBranch`).
   - Update `Contract` setting `githubRepoId = repoMeta.id`, `githubRepoOwner = repoMeta.owner`, `githubRepoName = repoMeta.name`.
   - Record `AuditLog` event (`entityType: "CONTRACT"`, `action: "REPOSITORY_ASSOCIATED"`).

---

### 3.3 Webhook Ingestion & Deduplication (`src/modules/github/webhook/`)

#### Responsibilities:
- Receives inbound HTTP POST notifications at `/api/webhooks/github`.
- Validates the `X-Hub-Signature-256` header against the raw body Buffer using HMAC-SHA256 and `crypto.timingSafeEqual`.
- Validates presence and format of required headers (`x-github-delivery`, `x-github-event`).
- Persists webhook deliveries durably in `GitHubWebhookDelivery` with status `RECEIVED`.
- Provides strict idempotent duplicate delivery protection:
  - If a delivery arrives with an identical `deliveryId` and matching `payloadHash`, returns HTTP 200/202 without reprocessing.
  - If a delivery arrives with an identical `deliveryId` but different `payloadHash`, returns HTTP 409 Conflict.
- Decouples fast delivery acknowledgement from downstream evidence processing.

#### Webhook State Machine:
```
  [ INBOUND HTTP POST ]
            │
   Verify Signature (HMAC-SHA256)
   Verify Delivery ID
            │
            ├── (Invalid / Missing) ──► 401 Unauthorized / 400 Bad Request
            │
     Check Existing Delivery ID
            │
            ├── (Exists & Hash Match) ──► 200 OK (Idempotent Acknowledged)
            ├── (Exists & Hash Mismatch) ──► 409 Conflict
            │
    Persist Delivery (RECEIVED)
            │
            ▼
     202 Accepted
            │
    [ Async Dispatch / Claim ]
            │
         RECEIVED
            │
            ├──► PROCESSING ──► PROCESSED (Terminal)
            │          │
            │          └──► FAILED (Retriable)
            │
            └──► IGNORED (Unsupported Event / Terminal)
```

---

### 3.4 Evidence Ingestion & Snapshot Binding (`src/modules/github/evidence/`)

#### Responsibilities:
- Ingests pull request and commit data from GitHub for an authorized `MilestoneSubmission`.
- Validates that the submitted PR and commit belong to the configured contract repository:
  - `pr.repositoryId === contract.githubRepoId` (prevents cross-repository evidence substitution).
  - `pr.headSha === submission.prCommitSha` (verifies developer submission commit integrity).
  - `submission.milestoneId === milestone.id` (composite foreign key consistency).
- Constructs a structured, normalized evidence object:
  - Repository ID, PR ID, number, URL, title, description, author, creation/update timestamps.
  - Head branch, head commit SHA, base branch, base commit SHA.
  - PR merge status, mergedAt, mergeCommitSha.
  - Commit list with author, date, message, tree SHA, and parent SHAs.
  - Check suite summaries with status and conclusion breakdowns.
  - Collection metadata: timestamp, provider ("github"), API version ("2022-11-28").
- Computes canonical RFC 8785 SHA-256 `evidenceHash`.
- Persists an immutable `GitHubEvidenceSnapshot` record under submission versioning.
- Triggers immutable audit logs (`EVIDENCE_COLLECTION_STARTED`, `EVIDENCE_SNAPSHOT_CREATED`).

---

## 4. Database Schema Evolution & Constraints

### 4.1 Schema Additions (Prisma & PostgreSQL DDL)

#### 1. Enums
```prisma
enum GitHubDeliveryStatus {
  RECEIVED
  PROCESSING
  PROCESSED
  FAILED
  IGNORED
}

enum GitHubCheckStatus {
  PENDING
  SUCCESS
  FAILURE
  UNAVAILABLE
}
```

#### 2. Models
```prisma
model GitHubRepository {
  id             String     @id @db.VarChar(36)
  repoId         BigInt     @unique @db.BigInt
  owner          String     @db.VarChar(100)
  name           String     @db.VarChar(100)
  fullName       String     @db.VarChar(200)
  installationId BigInt?    @db.BigInt
  isPrivate      Boolean    @default(false)
  defaultBranch  String     @default("main") @db.VarChar(100)
  htmlUrl        String     @db.VarChar(500)
  description    String?    @db.Text
  createdAt      DateTime   @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime   @default(now()) @updatedAt @db.Timestamptz(6)

  contracts      Contract[]

  @@index([owner, name], map: "idx_github_repo_owner_name")
  @@map("GitHubRepository")
}

model GitHubWebhookDelivery {
  id           String               @id @db.VarChar(36)
  deliveryId   String               @unique @db.VarChar(64)
  eventType    String               @db.VarChar(50)
  action       String?              @db.VarChar(50)
  status       GitHubDeliveryStatus @default(RECEIVED)
  repositoryId BigInt?              @db.BigInt
  payload      Json                 @db.JsonB
  payloadHash  String               @db.VarChar(64)
  errorMessage String?              @db.Text
  processedAt  DateTime?            @db.Timestamptz(6)
  createdAt    DateTime             @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime             @default(now()) @updatedAt @db.Timestamptz(6)

  @@index([status], map: "idx_github_delivery_status")
  @@index([repositoryId], map: "idx_github_delivery_repo")
  @@index([createdAt(sort: Desc)], map: "idx_github_delivery_created")
  @@map("GitHubWebhookDelivery")
}

model GitHubEvidenceSnapshot {
  id              String            @id @db.VarChar(36)
  submissionId    String            @db.VarChar(36)
  milestoneId     String            @db.VarChar(36)
  snapshotVersion Int               @default(1) @db.Integer
  repositoryId    BigInt            @db.BigInt
  repoOwner       String            @db.VarChar(100)
  repoName        String            @db.VarChar(100)
  prNumber        Int               @db.Integer
  prId            BigInt?           @db.BigInt
  prUrl           String            @db.VarChar(1000)
  prTitle         String            @db.VarChar(500)
  prBody          String?           @db.Text
  prAuthor        String            @db.VarChar(100)
  prAuthorId      BigInt?           @db.BigInt
  prState         String            @db.VarChar(50)
  isMerged        Boolean           @default(false)
  mergedAt        DateTime?         @db.Timestamptz(6)
  mergeCommitSha  String?           @db.VarChar(40)
  headBranch      String            @db.VarChar(200)
  headCommitSha   String            @db.VarChar(40)
  baseBranch      String            @db.VarChar(200)
  baseCommitSha   String            @db.VarChar(40)
  commitCount     Int               @default(0) @db.Integer
  commits         Json              @db.JsonB
  checks          Json              @db.JsonB
  checksStatus    GitHubCheckStatus @default(UNAVAILABLE)
  rawPayload      Json?             @db.JsonB
  evidenceHash    String            @db.VarChar(64)
  collectedAt     DateTime          @default(now()) @db.Timestamptz(6)
  provider        String            @default("github") @db.VarChar(50)
  apiVersion      String            @default("2022-11-28") @db.VarChar(50)

  submission      MilestoneSubmission @relation(fields: [submissionId, milestoneId], references: [id, milestoneId], onDelete: Restrict, map: "fk_evidence_submission_milestone_scoped")

  @@unique([submissionId, snapshotVersion], map: "uq_submission_evidence_version")
  @@index([submissionId], map: "idx_evidence_submission")
  @@index([milestoneId], map: "idx_evidence_milestone")
  @@index([repositoryId], map: "idx_evidence_repo")
  @@map("GitHubEvidenceSnapshot")
}
```

### 4.2 Database Constraints & Immutability Trigger
1. **Scoped Composite FK**:
   `CONSTRAINT fk_evidence_submission_milestone_scoped FOREIGN KEY ("submissionId", "milestoneId") REFERENCES "MilestoneSubmission"("id", "milestoneId") ON DELETE RESTRICT`
   Prevents an evidence snapshot from referencing a submission belonging to another milestone.
2. **Strict Append-Only Immutability**:
   `trg_evidence_snapshot_immutable` raises SQLSTATE `55000` on any `UPDATE` or `DELETE` attempt against `GitHubEvidenceSnapshot`.
3. **Role-Based Privilege Separation**:
   `verirelease_app_user` is granted `SELECT, INSERT` on `GitHubEvidenceSnapshot`. `UPDATE, DELETE, TRUNCATE` are revoked.

---

## 5. Security Architecture & Threat Mitigations

| Threat | Attack Vector | Mitigation Control |
|:---|:---|:---|
| **Webhook Forgery** | Attacker sends crafted HTTP requests to webhook endpoint | HMAC-SHA256 signature verification over exact raw request body using constant-time comparison (`crypto.timingSafeEqual`). Rejects missing or malformed signatures with 401. |
| **Replay Attack** | Attacker replays valid previously intercepted webhook delivery | `X-GitHub-Delivery` GUID uniqueness constraint in `GitHubWebhookDelivery`. Subsequent deliveries with identical delivery ID and identical body are treated as idempotent duplicates (HTTP 200). Differing payloads with reused ID are rejected with 409 Conflict. |
| **Arbitrary Repo Hijacking** | User attaches a third-party repo to a contract | Repository association requires caller authorization (contract client/developer), fetches authoritative metadata via provider, and records stable numeric `repoId`. |
| **Cross-Repository Evidence Forgery** | Submitter submits PR from a different repository | Evidence collection verifies that `pr.repositoryId === contract.githubRepoId`. PRs from unauthorized repositories are rejected before snapshot creation. |
| **Commit SHA Tampering** | Submitter submits commit SHA not present on PR head | Provider verifies `pr.headSha === submission.prCommitSha`. Divergent SHAs cause immediate rejection. |
| **Evidence Snapshot Mutation** | Malicious actor modifies evidence after collection | PostgreSQL trigger `trg_evidence_snapshot_immutable` blocks all `UPDATE` and `DELETE` statements (SQLSTATE `55000`). Database role `verirelease_app_user` has `UPDATE` and `DELETE` revoked. |
| **Credential & Token Exposure** | Token logged in traces, error messages, or audit logs | GitHub tokens and webhook secrets are loaded through `src/lib/env.ts` and masked/redacted in all HTTP logging, error reporting, and audit records. |

---

## 6. Audit Logging Matrix

All M3 actions integrate with the existing append-only `TransactionalAuditService`:

| Action | Entity Type | Entity ID | Actor Type | Key Metadata |
|:---|:---|:---|:---|:---|
| `REPOSITORY_ASSOCIATED` | `CONTRACT` | `contractId` | `USER` | `repoId`, `repoFullName`, `isPrivate` |
| `WEBHOOK_SIGNATURE_REJECTED` | `CONTRACT` / `GITHUB_DELIVERY` | `deliveryId` | `WEBHOOK_GITHUB` | `reason`, `ipAddress` (redacted headers) |
| `WEBHOOK_DELIVERY_ACCEPTED` | `GITHUB_DELIVERY` | `deliveryId` | `WEBHOOK_GITHUB` | `eventType`, `action`, `repositoryId` |
| `DUPLICATE_DELIVERY_DETECTED` | `GITHUB_DELIVERY` | `deliveryId` | `WEBHOOK_GITHUB` | `deliveryId`, `eventType` |
| `EVIDENCE_COLLECTION_STARTED` | `SUBMISSION` | `submissionId` | `USER` / `SYSTEM_PRINCIPAL` | `milestoneId`, `prNumber`, `commitSha` |
| `EVIDENCE_SNAPSHOT_CREATED` | `SUBMISSION` | `submissionId` | `USER` / `SYSTEM_PRINCIPAL` | `snapshotId`, `snapshotVersion`, `evidenceHash`, `repoId` |
| `EVIDENCE_COLLECTION_FAILED` | `SUBMISSION` | `submissionId` | `USER` / `SYSTEM_PRINCIPAL` | `milestoneId`, `prNumber`, `errorCode` |

---

## 7. Verification & Testing Strategy

1. **Unit Testing**:
   - Webhook HMAC-SHA256 signature verification (valid, invalid, missing, altered body, timingSafeEqual).
   - Delivery deduplication logic (new, duplicate match, conflict mismatch).
   - Provider HTTP adapter (pagination, rate limiting, timeouts, 404/403/422/500 error mapping, secret redaction).
   - Evidence normalization and canonical JSON hashing.
2. **PostgreSQL Integration Testing**:
   - `GitHubRepository`, `GitHubWebhookDelivery`, and `GitHubEvidenceSnapshot` table constraints.
   - Composite foreign key enforcement (`fk_evidence_submission_milestone_scoped`).
   - Immutability trigger verification (UPDATE and DELETE raise `55000`).
   - Database role security (`verirelease_app_user` permissions).
   - Full evidence ingestion workflow and audit event persistence.
3. **Regression Testing**:
   - All 310 existing Milestone 1 and 2 tests must pass without modifications.
