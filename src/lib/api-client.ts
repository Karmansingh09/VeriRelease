/**
 * VeriRelease Typed Frontend API Client & Formatting Utilities
 */

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  githubUsername: string | null;
  isActive?: boolean;
}

export interface SystemStatus {
  appName: string;
  environment: string;
  githubOAuthConfigured: boolean;
  demoAuthEnabled: boolean;
  aiMode: "openai" | "demo";
  paypalMode: "sandbox" | "live" | "mock";
}

export interface MilestoneSummary {
  id: string;
  contractId: string;
  title: string;
  description: string;
  orderIndex: number;
  amountMinorUnits: string;
  currency: "USD" | "EUR" | "GBP";
  status:
    | "DRAFT"
    | "FUNDED"
    | "SUBMITTED"
    | "EVALUATING"
    | "ELIGIBLE_FOR_PAYOUT"
    | "CHANGES_REQUESTED"
    | "DISPUTED"
    | "CANCELLED";
  activeCriteriaVersion: number;
  fundedAt: string | null;
  createdAt: string;
  updatedAt: string;
  criteriaCount?: number;
  latestSubmissionStatus?: string | null;
  latestPrNumber?: number | null;
}

export interface ContractSummary {
  id: string;
  title: string;
  description: string;
  clientId: string;
  developerId: string;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  totalAmountMinorUnits: string;
  currency: "USD" | "EUR" | "GBP";
  githubRepoOwner: string;
  githubRepoName: string;
  createdAt: string;
  updatedAt: string;
  client: {
    id: string;
    email: string;
    name: string;
    role: string;
    githubUsername: string | null;
  };
  developer: {
    id: string;
    email: string;
    name: string;
    role: string;
    githubUsername: string | null;
  };
  milestones: MilestoneSummary[];
}

export interface AcceptanceCriterionItem {
  id: string;
  milestoneId: string;
  version: number;
  orderIndex: number;
  title: string;
  description: string;
  criterionType:
    | "AUTOMATED_TEST"
    | "FILE_CHANGE"
    | "CODE_QUALITY"
    | "SPECIFICATION"
    | "MANUAL_APPROVAL";
  isMandatory: boolean;
  createdAt: string;
}

export interface SubmissionItem {
  id: string;
  milestoneId: string;
  submissionNumber: number;
  prNumber: number;
  prCommitSha: string;
  prUrl: string;
  verifiedPrUrl?: string | null;
  isVerified?: boolean;
  criteriaVersion: number;
  criteriaHash: string;
  status: "PENDING" | "EVALUATED" | "SUPERSEDED";
  submittedById: string;
  submittedAt: string;
}

export interface AuditLogItem {
  id: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  timestamp: string;
  metadata: Record<string, unknown> | null;
}

export interface MilestoneDetailView extends MilestoneSummary {
  contract: ContractSummary;
  criteria: AcceptanceCriterionItem[];
  submissions: SubmissionItem[];
  auditTimeline: AuditLogItem[];
}

export interface PolicyEvaluationResultItem {
  criterionId: string;
  criterionTitle?: string;
  mandatory?: boolean;
  isMandatory?: boolean;
  passed: boolean;
  reason: string;
  confidence?: number;
  evidence?: Record<string, unknown>;
}

export interface PolicyEvaluationRecord {
  id: string;
  submissionId: string;
  milestoneId: string;
  criteriaHash: string;
  evaluationNumber: number;
  policyVersion: string;
  status: string;
  decision: "PASS" | "FAIL" | null;
  decisionReason: string | null;
  evaluations: PolicyEvaluationResultItem[] | null;
  receiptHash: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface EvidenceSnapshotRecord {
  id: string;
  submissionId: string;
  milestoneId: string;
  snapshotVersion: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prState: string;
  headBranch: string;
  headCommitSha: string;
  baseBranch: string;
  commitCount: number;
  checksStatus: "PENDING" | "SUCCESS" | "FAILURE" | "UNAVAILABLE";
  evidenceHash: string;
  collectedAt: string;
}

export interface EvaluationOutcomeResponse {
  aiEvaluation: {
    overallAssessment: string;
    suggestedAction: string;
    provider: string;
    model: string;
    isDemoMode: boolean;
    missingEvidence: string[];
    risks: string[];
    criterionAssessments: Array<{
      criterionId: string;
      criterionTitle: string;
      criterionType: string;
      isMandatory: boolean;
      passed: boolean;
      confidence: number;
      reason: string;
    }>;
  };
  policyEvaluation: PolicyEvaluationRecord;
  decision: "PASS" | "FAIL";
  decisionReason: string;
  milestoneStatus: string;
  receiptHash: string | null;
}

export interface PaymentTransactionItem {
  id: string;
  milestoneId: string;
  submissionId: string | null;
  transactionType: string;
  status:
    | "CREATED"
    | "RESERVED"
    | "PROCESSING"
    | "SUCCEEDED"
    | "FAILED"
    | "PAYOUT_UNCERTAIN"
    | "RECONCILIATION_REQUIRED";
  idempotencyKey: string;
  amountMinorUnits: string;
  currency: string;
  attemptNumber: number;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }

  if (!res.ok) {
    const msg =
      (typeof data.message === "string" && data.message) ||
      (typeof data.error === "string" && data.error) ||
      `Request failed with status ${res.status}`;
    throw new ApiClientError(res.status, msg);
  }

  return data as T;
}

/**
 * Formats integer minor currency units (e.g. "100050") into display money (e.g. "$1,000.50")
 * cleanly using BigInt without floating-point arithmetic.
 */
export function formatMinorUnits(
  amountMinor: string | bigint,
  currency: string = "USD"
): string {
  const minor = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor || "0");
  const isNegative = minor < 0n;
  const abs = isNegative ? -minor : minor;
  const whole = abs / 100n;
  const cents = abs % 100n;
  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const centsFormatted = cents.toString().padStart(2, "0");

  const symbol = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${isNegative ? "-" : ""}${symbol}${wholeFormatted}.${centsFormatted} ${currency}`;
}

export function shortHash(hash: string | null | undefined, length: number = 12): string {
  if (!hash) return "—";
  if (hash.length <= length + 4) return hash;
  return `${hash.slice(0, length)}…${hash.slice(-4)}`;
}

export function formatRelativeDate(dateIso: string | null | undefined): string {
  if (!dateIso) return "—";
  try {
    return new Date(dateIso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateIso;
  }
}
