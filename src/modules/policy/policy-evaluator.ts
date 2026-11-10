/**
 * VeriRelease Deterministic Policy Evaluation Engine
 *
 * Pure, testable evaluator that evaluates normalized criterion assessments
 * against the immutable acceptance-criteria snapshot attached to a milestone submission.
 *
 * CRITICAL TRUST BOUNDARY:
 * - AI may inspect evidence and produce proposed criterion assessments.
 * - AI output is strictly untrusted input.
 * - Deterministic application code validates those assessments and applies policy rules.
 * - Only the deterministic policy engine may produce the authoritative policy outcome.
 * - AI must never directly approve a milestone, authorize a payout, or execute a payment.
 * - ELIGIBLE_FOR_PAYOUT means policy eligibility only. It does not mean payment succeeded.
 *
 * PURITY GUARANTEES:
 * - Zero network calls, database access, random values, current-time dependencies, or AI provider calls.
 * - Same output for same validated input regardless of execution order or environment.
 */

import { canonicalizeJson, escapeJsonString } from "../common/canonical-json";
import { DomainValidationError } from "../common/errors";
import type { CriteriaSnapshotItem } from "../contracts/types";
import type { CriterionEvaluation, PolicyDecision } from "./types";

/**
 * Untrusted criterion assessment input (e.g. proposed by AI or test runners).
 */
export interface CriterionAssessmentInput {
  criterionId: string;
  passed: boolean;
  evidence?: Record<string, unknown> | null;
  reason?: string | null;
  confidence?: number | null;
}

/**
 * Detailed summary breakdown of policy evaluation metrics.
 */
export interface PolicyEvaluationSummary {
  totalCriteria: number;
  mandatoryCriteria: number;
  passedMandatory: number;
  failedMandatory: number;
  optionalCriteria: number;
  passedOptional: number;
  failedOptional: number;
}

/**
 * Deterministic output produced by the pure policy evaluator.
 */
export interface PolicyEvaluationOutput {
  decision: PolicyDecision;
  decisionReason: string;
  evaluations: CriterionEvaluation[];
  summary: PolicyEvaluationSummary;
}

/**
 * Validates a single untrusted raw assessment item.
 *
 * @throws {DomainValidationError} If the assessment is malformed or invalid.
 */
function validateRawAssessment(
  raw: unknown,
  index: number
): CriterionAssessmentInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DomainValidationError(
      `Assessment at index ${index} must be a non-null object`
    );
  }

  const record = raw as Record<string, unknown>;

  // Validate criterionId
  if (
    typeof record.criterionId !== "string" ||
    record.criterionId.trim().length === 0
  ) {
    throw new DomainValidationError(
      `Assessment at index ${index} must have a non-empty string 'criterionId'`
    );
  }

  try {
    escapeJsonString(record.criterionId);
  } catch (err: unknown) {
    if (err instanceof DomainValidationError) {
      throw new DomainValidationError(
        `Assessment at index ${index} has invalid 'criterionId': ${err.message}`
      );
    }
    throw err;
  }

  // Validate passed: strictly boolean (no truthy coercion, numbers, or strings)
  if (typeof record.passed !== "boolean") {
    throw new DomainValidationError(
      `Assessment for criterion '${record.criterionId}' must have a boolean 'passed' value (got: ${typeof record.passed})`
    );
  }

  // Validate evidence: if present and non-null, must be a plain object (not array, primitive, etc.)
  // and recursively validated as canonical JSON-compatible data
  if (record.evidence !== undefined && record.evidence !== null) {
    if (typeof record.evidence !== "object" || Array.isArray(record.evidence)) {
      throw new DomainValidationError(
        `Assessment for criterion '${record.criterionId}' has invalid 'evidence': must be an object/record`
      );
    }

    try {
      // Recursively validates nested values, non-finite numbers, circular references,
      // invalid strings, functions, symbols, BigInt, and Date instances per RFC 8785
      canonicalizeJson(record.evidence);
    } catch (err: unknown) {
      if (err instanceof DomainValidationError) {
        throw new DomainValidationError(
          `Assessment for criterion '${record.criterionId}' has invalid 'evidence': ${err.message}`
        );
      }
      throw err;
    }
  }

  // Validate reason: optional string
  if (
    record.reason !== undefined &&
    record.reason !== null
  ) {
    if (typeof record.reason !== "string") {
      throw new DomainValidationError(
        `Assessment for criterion '${record.criterionId}' has invalid 'reason': must be a string`
      );
    }
    try {
      escapeJsonString(record.reason);
    } catch (err: unknown) {
      if (err instanceof DomainValidationError) {
        throw new DomainValidationError(
          `Assessment for criterion '${record.criterionId}' has invalid 'reason': ${err.message}`
        );
      }
      throw err;
    }
  }

  // Validate confidence: optional number between 0 and 1
  if (
    record.confidence !== undefined &&
    record.confidence !== null &&
    (typeof record.confidence !== "number" ||
      Number.isNaN(record.confidence) ||
      record.confidence < 0 ||
      record.confidence > 1)
  ) {
    throw new DomainValidationError(
      `Assessment for criterion '${record.criterionId}' has invalid 'confidence': must be a number between 0.0 and 1.0`
    );
  }

  return {
    criterionId: record.criterionId.trim(),
    passed: record.passed,
    evidence: record.evidence as Record<string, unknown> | null | undefined,
    reason: record.reason as string | null | undefined,
    confidence: record.confidence as number | null | undefined,
  };
}

/**
 * Pure, deterministic policy evaluator.
 *
 * Evaluates untrusted criterion assessments against the immutable criteria snapshot.
 *
 * RULES:
 * 1. Criteria snapshot must be non-empty.
 * 2. Every supplied assessment must map to exactly one criterion in the snapshot.
 * 3. Rejects unknown, duplicate, missing, or malformed criterion results.
 * 4. Output evaluations are ordered deterministically by snapshot orderIndex ASC, then criterionId ASC.
 * 5. Decision is PASS if and only if EVERY mandatory criterion passed.
 * 6. If any mandatory criterion fails, decision is FAIL.
 * 7. Optional criteria failures are recorded in the evaluation breakdown but do not fail the overall policy.
 *
 * @throws {DomainValidationError} On any validation failure.
 */
export function evaluatePolicy(
  criteriaSnapshot: readonly CriteriaSnapshotItem[],
  assessments: readonly unknown[]
): PolicyEvaluationOutput {
  // 1. Validate criteriaSnapshot
  if (
    !criteriaSnapshot ||
    !Array.isArray(criteriaSnapshot) ||
    criteriaSnapshot.length === 0
  ) {
    throw new DomainValidationError(
      "Criteria snapshot must be a non-empty array of criteria items"
    );
  }

  // 2. Build snapshot lookup map and assert snapshot validity
  const snapshotMap = new Map<string, CriteriaSnapshotItem>();
  for (let i = 0; i < criteriaSnapshot.length; i++) {
    const item = criteriaSnapshot[i]!;
    if (
      !item ||
      typeof item.criterionId !== "string" ||
      item.criterionId.trim().length === 0
    ) {
      throw new DomainValidationError(
        `Criteria snapshot item at index ${i} has invalid criterionId`
      );
    }
    if (snapshotMap.has(item.criterionId)) {
      throw new DomainValidationError(
        `Criteria snapshot contains duplicate criterionId '${item.criterionId}'`
      );
    }
    snapshotMap.set(item.criterionId, item);
  }

  // 3. Validate assessments array
  if (!assessments || !Array.isArray(assessments)) {
    throw new DomainValidationError(
      "Assessments must be provided as an array"
    );
  }

  if (assessments.length === 0) {
    throw new DomainValidationError(
      "Assessments array cannot be empty: must provide assessment results for all criteria in snapshot"
    );
  }

  // 4. Validate individual assessments, reject duplicates and unknown criterion IDs
  const assessmentMap = new Map<string, CriterionAssessmentInput>();
  for (let i = 0; i < assessments.length; i++) {
    const validated = validateRawAssessment(assessments[i], i);

    // Reject unknown criterion ID
    if (!snapshotMap.has(validated.criterionId)) {
      throw new DomainValidationError(
        `Unknown criterion ID '${validated.criterionId}': not found in submission criteria snapshot`
      );
    }

    // Reject duplicate assessment for the same criterion ID
    if (assessmentMap.has(validated.criterionId)) {
      throw new DomainValidationError(
        `Duplicate assessment result for criterion ID '${validated.criterionId}'`
      );
    }

    assessmentMap.set(validated.criterionId, validated);
  }

  // 5. Enforce 1:1 mapping: every criterion in snapshot must have a corresponding assessment
  for (const criterion of criteriaSnapshot) {
    if (!assessmentMap.has(criterion.criterionId)) {
      throw new DomainValidationError(
        `Missing assessment result for criterion ID '${criterion.criterionId}' ('${criterion.title}')`
      );
    }
  }

  // Enforce total count matches (defense-in-depth against unexpected surplus)
  if (assessmentMap.size !== criteriaSnapshot.length) {
    throw new DomainValidationError(
      `Assessment count mismatch: snapshot defines ${criteriaSnapshot.length} criteria, but ${assessmentMap.size} unique assessments were provided`
    );
  }

  // 6. Sort snapshot items deterministically: orderIndex ASC, then criterionId ASC
  const sortedSnapshot = [...criteriaSnapshot].sort((a, b) => {
    if (a.orderIndex !== b.orderIndex) {
      return a.orderIndex - b.orderIndex;
    }
    return a.criterionId.localeCompare(b.criterionId);
  });

  // 7. Deterministically evaluate criteria and track metrics
  const evaluations: CriterionEvaluation[] = [];
  const failedMandatory: Array<{ criterionId: string; title: string; reason?: string | null }> = [];
  const failedOptional: Array<{ criterionId: string; title: string; reason?: string | null }> = [];

  let mandatoryCount = 0;
  let passedMandatoryCount = 0;
  let optionalCount = 0;
  let passedOptionalCount = 0;

  for (const criterion of sortedSnapshot) {
    const assessment = assessmentMap.get(criterion.criterionId)!;

    // Construct evidence record cleanly preserving any caller-provided evidence and reason
    const evidence: Record<string, unknown> = {
      ...(assessment.evidence ?? {}),
    };
    if (assessment.reason !== undefined && assessment.reason !== null && evidence.reason === undefined) {
      evidence.reason = assessment.reason;
    }
    if (assessment.confidence !== undefined && assessment.confidence !== null && evidence.confidence === undefined) {
      evidence.confidence = assessment.confidence;
    }

    evaluations.push({
      criterionId: criterion.criterionId,
      criterionType: criterion.criterionType,
      passed: assessment.passed,
      evidence,
    });

    if (criterion.isMandatory) {
      mandatoryCount++;
      if (assessment.passed) {
        passedMandatoryCount++;
      } else {
        failedMandatory.push({
          criterionId: criterion.criterionId,
          title: criterion.title,
          reason: assessment.reason,
        });
      }
    } else {
      optionalCount++;
      if (assessment.passed) {
        passedOptionalCount++;
      } else {
        failedOptional.push({
          criterionId: criterion.criterionId,
          title: criterion.title,
          reason: assessment.reason,
        });
      }
    }
  }

  // 8. Deterministic Decision & Decision Reason
  const isPass = failedMandatory.length === 0;
  const decision: PolicyDecision = isPass ? "PASS" : "FAIL";

  let decisionReason: string;
  if (isPass) {
    if (failedOptional.length > 0) {
      const failedOptionalDetails = failedOptional
        .map((f) => `${f.title} (${f.criterionId})`)
        .join(", ");
      decisionReason = `Policy approved: all ${passedMandatoryCount} mandatory criteria passed (${failedOptional.length} optional criteria failed: ${failedOptionalDetails})`;
    } else {
      decisionReason =
        mandatoryCount === sortedSnapshot.length
          ? `Policy approved: all ${passedMandatoryCount} mandatory criteria passed successfully`
          : `Policy approved: all ${sortedSnapshot.length} criteria passed successfully`;
    }
  } else {
    const failedMandatoryDetails = failedMandatory
      .map((f) => {
        const reasonSuffix = f.reason ? ` - ${f.reason}` : "";
        return `${f.title} (${f.criterionId})${reasonSuffix}`;
      })
      .join("; ");
    decisionReason = `Policy rejected: ${failedMandatory.length} mandatory criteria failed: ${failedMandatoryDetails}`;
  }

  return {
    decision,
    decisionReason,
    evaluations,
    summary: {
      totalCriteria: sortedSnapshot.length,
      mandatoryCriteria: mandatoryCount,
      passedMandatory: passedMandatoryCount,
      failedMandatory: failedMandatory.length,
      optionalCriteria: optionalCount,
      passedOptional: passedOptionalCount,
      failedOptional: failedOptional.length,
    },
  };
}
