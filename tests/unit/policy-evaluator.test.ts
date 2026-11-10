import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../../src/modules/policy/policy-evaluator";
import { DomainValidationError } from "../../src/modules/common/errors";
import type { CriteriaSnapshotItem, CriterionType } from "../../src/modules/contracts/types";

describe("Deterministic Policy Evaluator Unit Tests", () => {
  const sampleCriteriaSnapshot: CriteriaSnapshotItem[] = [
    {
      criterionId: "crit_001",
      criterionType: "AUTOMATED_TEST" as CriterionType,
      title: "Unit Tests",
      description: "All unit tests in vitest must pass cleanly",
      isMandatory: true,
      orderIndex: 1,
    },
    {
      criterionId: "crit_002",
      criterionType: "CODE_QUALITY" as CriterionType,
      title: "ESLint & Typecheck",
      description: "Zero ESLint warnings or TypeScript errors",
      isMandatory: true,
      orderIndex: 2,
    },
    {
      criterionId: "crit_003",
      criterionType: "SPECIFICATION" as CriterionType,
      title: "Optional Performance Benchmark",
      description: "Response time should be under 200ms",
      isMandatory: false,
      orderIndex: 3,
    },
  ];

  it("Requirement 1: All mandatory criteria pass", () => {
    const assessments = [
      {
        criterionId: "crit_001",
        passed: true,
        evidence: { testCount: 42, passedCount: 42 },
      },
      {
        criterionId: "crit_002",
        passed: true,
        evidence: { lintErrors: 0, tsErrors: 0 },
      },
      {
        criterionId: "crit_003",
        passed: true,
        evidence: { latencyMs: 145 },
      },
    ];

    const result = evaluatePolicy(sampleCriteriaSnapshot, assessments);

    expect(result.decision).toBe("PASS");
    expect(result.decisionReason).toContain("Policy approved");
    expect(result.summary.totalCriteria).toBe(3);
    expect(result.summary.mandatoryCriteria).toBe(2);
    expect(result.summary.passedMandatory).toBe(2);
    expect(result.summary.failedMandatory).toBe(0);
    expect(result.summary.optionalCriteria).toBe(1);
    expect(result.summary.passedOptional).toBe(1);
    expect(result.summary.failedOptional).toBe(0);

    expect(result.evaluations).toHaveLength(3);
    expect(result.evaluations[0]!.criterionId).toBe("crit_001");
    expect(result.evaluations[0]!.passed).toBe(true);
    expect(result.evaluations[1]!.criterionId).toBe("crit_002");
    expect(result.evaluations[1]!.passed).toBe(true);
    expect(result.evaluations[2]!.criterionId).toBe("crit_003");
    expect(result.evaluations[2]!.passed).toBe(true);
  });

  it("Requirement 2: A mandatory criterion fails", () => {
    const assessments = [
      {
        criterionId: "crit_001",
        passed: true,
        evidence: { testCount: 42, passedCount: 42 },
      },
      {
        criterionId: "crit_002",
        passed: false,
        reason: "TypeScript compilation failed with 2 errors",
        evidence: { errors: ["TS2322: Type mismatch"] },
      },
      {
        criterionId: "crit_003",
        passed: true,
        evidence: { latencyMs: 120 },
      },
    ];

    const result = evaluatePolicy(sampleCriteriaSnapshot, assessments);

    expect(result.decision).toBe("FAIL");
    expect(result.decisionReason).toContain("Policy rejected: 1 mandatory criteria failed");
    expect(result.decisionReason).toContain("ESLint & Typecheck (crit_002)");
    expect(result.summary.mandatoryCriteria).toBe(2);
    expect(result.summary.passedMandatory).toBe(1);
    expect(result.summary.failedMandatory).toBe(1);

    expect(result.evaluations).toHaveLength(3);
    expect(result.evaluations[1]!.criterionId).toBe("crit_002");
    expect(result.evaluations[1]!.passed).toBe(false);
    expect(result.evaluations[1]!.evidence).toMatchObject({
      errors: ["TS2322: Type mismatch"],
      reason: "TypeScript compilation failed with 2 errors",
    });
  });

  it("Requirement 3: An optional criterion fails while all mandatory criteria pass", () => {
    const assessments = [
      {
        criterionId: "crit_001",
        passed: true,
        evidence: { testCount: 50, passedCount: 50 },
      },
      {
        criterionId: "crit_002",
        passed: true,
        evidence: { lintErrors: 0 },
      },
      {
        criterionId: "crit_003",
        passed: false,
        reason: "Benchmark latency was 280ms, exceeding 200ms target",
        evidence: { latencyMs: 280 },
      },
    ];

    const result = evaluatePolicy(sampleCriteriaSnapshot, assessments);

    // Optional failure must NOT fail the overall policy evaluation
    expect(result.decision).toBe("PASS");
    expect(result.decisionReason).toContain("Policy approved");
    expect(result.decisionReason).toContain("1 optional criteria failed: Optional Performance Benchmark (crit_003)");
    expect(result.summary.mandatoryCriteria).toBe(2);
    expect(result.summary.passedMandatory).toBe(2);
    expect(result.summary.failedMandatory).toBe(0);
    expect(result.summary.optionalCriteria).toBe(1);
    expect(result.summary.passedOptional).toBe(0);
    expect(result.summary.failedOptional).toBe(1);

    // Evaluation breakdown preserves individual failure accurately
    expect(result.evaluations[2]!.criterionId).toBe("crit_003");
    expect(result.evaluations[2]!.passed).toBe(false);
    expect(result.evaluations[2]!.evidence).toMatchObject({
      latencyMs: 280,
      reason: "Benchmark latency was 280ms, exceeding 200ms target",
    });
  });

  it("Requirement 4: Missing criterion result is rejected", () => {
    // Only 2 of the 3 criteria are supplied
    const incompleteAssessments = [
      { criterionId: "crit_001", passed: true },
      { criterionId: "crit_002", passed: true },
    ];

    expect(() =>
      evaluatePolicy(sampleCriteriaSnapshot, incompleteAssessments)
    ).toThrow(DomainValidationError);

    expect(() =>
      evaluatePolicy(sampleCriteriaSnapshot, incompleteAssessments)
    ).toThrow(/Missing assessment result for criterion ID 'crit_003'/);
  });

  it("Requirement 5: Duplicate criterion result is rejected", () => {
    const duplicateAssessments = [
      { criterionId: "crit_001", passed: true },
      { criterionId: "crit_001", passed: false }, // Duplicate crit_001!
      { criterionId: "crit_002", passed: true },
    ];

    expect(() =>
      evaluatePolicy(sampleCriteriaSnapshot, duplicateAssessments)
    ).toThrow(DomainValidationError);

    expect(() =>
      evaluatePolicy(sampleCriteriaSnapshot, duplicateAssessments)
    ).toThrow(/Duplicate assessment result for criterion ID 'crit_001'/);
  });

  it("Requirement 6: Unknown criterion ID is rejected", () => {
    const rogueAssessments = [
      { criterionId: "crit_001", passed: true },
      { criterionId: "crit_002", passed: true },
      { criterionId: "crit_rogue_999", passed: true }, // Not in snapshot!
    ];

    expect(() =>
      evaluatePolicy(sampleCriteriaSnapshot, rogueAssessments)
    ).toThrow(DomainValidationError);

    expect(() =>
      evaluatePolicy(sampleCriteriaSnapshot, rogueAssessments)
    ).toThrow(/Unknown criterion ID 'crit_rogue_999'/);
  });

  describe("Requirement 7: Malformed or unsupported assessment values are rejected", () => {
    it("rejects assessment that is not a non-null object", () => {
      expect(() =>
        evaluatePolicy(sampleCriteriaSnapshot, [null, "bad", 123])
      ).toThrow(DomainValidationError);
    });

    it("rejects assessment with missing or empty criterionId", () => {
      const badId = [
        { criterionId: "", passed: true },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];

      expect(() => evaluatePolicy(sampleCriteriaSnapshot, badId)).toThrow(
        DomainValidationError
      );
    });

    it("rejects assessment with non-boolean passed value (string 'true')", () => {
      const badPassed = [
        { criterionId: "crit_001", passed: "true" as any },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];

      expect(() => evaluatePolicy(sampleCriteriaSnapshot, badPassed)).toThrow(
        /must have a boolean 'passed' value/
      );
    });

    it("rejects assessment with numeric passed value (1)", () => {
      const badPassed = [
        { criterionId: "crit_001", passed: 1 as any },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];

      expect(() => evaluatePolicy(sampleCriteriaSnapshot, badPassed)).toThrow(
        /must have a boolean 'passed' value/
      );
    });

    it("rejects assessment with invalid evidence (array instead of object)", () => {
      const badEvidence = [
        { criterionId: "crit_001", passed: true, evidence: ["array", "invalid"] as any },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];

      expect(() => evaluatePolicy(sampleCriteriaSnapshot, badEvidence)).toThrow(
        /has invalid 'evidence'/
      );
    });

    it("rejects assessment with invalid confidence value outside [0, 1]", () => {
      const badConfidence = [
        { criterionId: "crit_001", passed: true, confidence: 1.5 },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];

      expect(() => evaluatePolicy(sampleCriteriaSnapshot, badConfidence)).toThrow(
        /must be a number between 0.0 and 1.0/
      );
    });

    it("1. rejects nested NaN and Infinity in evidence", () => {
      const nanEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { metrics: { score: NaN } } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, nanEvidence)).toThrow(
        /Cannot canonicalize non-finite number: NaN/
      );

      const infEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { metrics: { score: Infinity } } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, infEvidence)).toThrow(
        /Cannot canonicalize non-finite number: Infinity/
      );
    });

    it("2. rejects nested undefined in evidence", () => {
      const undefinedEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { nested: { missingValue: undefined } } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, undefinedEvidence)).toThrow(
        /unsupported non-JSON value.*undefined/i
      );
    });

    it("3. rejects nested BigInt in evidence", () => {
      const bigintEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { nested: { amount: 100000n } } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, bigintEvidence)).toThrow(
        /unsupported non-JSON value.*bigint/i
      );
    });

    it("4. rejects nested function and symbol in evidence", () => {
      const fnEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { run: () => {} } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, fnEvidence)).toThrow(
        /unsupported non-JSON value.*function/i
      );

      const symEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { tag: Symbol("tag") } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, symEvidence)).toThrow(
        /unsupported non-JSON value.*symbol/i
      );
    });

    it("5. rejects circular references in evidence", () => {
      const circularObj: Record<string, unknown> = { key: "value" };
      circularObj.self = circularObj;

      const circularEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { nested: circularObj } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, circularEvidence)).toThrow(
        /Circular reference detected/
      );
    });

    it("6. rejects invalid nested strings with lone surrogates in evidence", () => {
      const loneSurrogateEvidence = [
        { criterionId: "crit_001", passed: true, evidence: { message: "Invalid Unicode \uD800 alone" } },
        { criterionId: "crit_002", passed: true },
        { criterionId: "crit_003", passed: true },
      ];
      expect(() => evaluatePolicy(sampleCriteriaSnapshot, loneSurrogateEvidence)).toThrow(
        /Invalid Unicode: lone high surrogate/
      );
    });

    it("7. accepts valid deeply nested canonical JSON evidence structures", () => {
      const validNestedEvidence = [
        {
          criterionId: "crit_001",
          passed: true,
          evidence: {
            deep: {
              array: [1, 2, "three", true, null, { key: "value" }],
              score: 98.6,
              passed: true,
              extra: null,
            },
          },
        },
        { criterionId: "crit_002", passed: true, evidence: {} },
        { criterionId: "crit_003", passed: true, evidence: { list: [] } },
      ];

      const result = evaluatePolicy(sampleCriteriaSnapshot, validNestedEvidence);
      expect(result.decision).toBe("PASS");
      expect(result.evaluations[0]!.evidence).toEqual({
        deep: {
          array: [1, 2, "three", true, null, { key: "value" }],
          score: 98.6,
          passed: true,
          extra: null,
        },
      });
    });
  });

  describe("Requirement 8: Empty criteria snapshot is rejected", () => {
    it("rejects empty snapshot array", () => {
      expect(() => evaluatePolicy([], [{ criterionId: "crit_1", passed: true }])).toThrow(
        DomainValidationError
      );
      expect(() => evaluatePolicy([], [{ criterionId: "crit_1", passed: true }])).toThrow(
        /Criteria snapshot must be a non-empty array/
      );
    });

    it("rejects null or non-array snapshot", () => {
      expect(() => evaluatePolicy(null as any, [])).toThrow(DomainValidationError);
    });
  });

  it("Requirement 9: Deterministic output for identical inputs regardless of execution order", () => {
    // Assessments provided in reverse order [crit_003, crit_002, crit_001]
    const orderA = [
      { criterionId: "crit_003", passed: true, evidence: { latency: 150 } },
      { criterionId: "crit_002", passed: true, evidence: { lint: "clean" } },
      { criterionId: "crit_001", passed: true, evidence: { tests: 10 } },
    ];

    // Assessments provided in random order [crit_002, crit_001, crit_003]
    const orderB = [
      { criterionId: "crit_002", passed: true, evidence: { lint: "clean" } },
      { criterionId: "crit_001", passed: true, evidence: { tests: 10 } },
      { criterionId: "crit_003", passed: true, evidence: { latency: 150 } },
    ];

    const resultA = evaluatePolicy(sampleCriteriaSnapshot, orderA);
    const resultB = evaluatePolicy(sampleCriteriaSnapshot, orderB);

    // Outputs must be strictly equal
    expect(resultA).toEqual(resultB);

    // Evaluations array must be deterministically sorted by orderIndex ASC (crit_001, crit_002, crit_003)
    expect(resultA.evaluations.map((e) => e.criterionId)).toEqual([
      "crit_001",
      "crit_002",
      "crit_003",
    ]);
    expect(resultB.evaluations.map((e) => e.criterionId)).toEqual([
      "crit_001",
      "crit_002",
      "crit_003",
    ]);
  });

  it("Requirement 10: Criteria snapshot remains authoritative even if current milestone criteria differ", () => {
    // Submission frozen snapshot captures Version 1 criteria:
    const submissionV1Snapshot: CriteriaSnapshotItem[] = [
      {
        criterionId: "crit_v1_auth",
        criterionType: "SPECIFICATION" as CriterionType,
        title: "V1 Auth Spec",
        description: "JWT token validation",
        isMandatory: true,
        orderIndex: 1,
      },
      {
        criterionId: "crit_v1_tests",
        criterionType: "AUTOMATED_TEST" as CriterionType,
        title: "V1 Test Suite",
        description: "10 unit tests",
        isMandatory: true,
        orderIndex: 2,
      },
    ];

    // Milestone active criteria may have since been amended to Version 2 (different IDs, different requirements)
    const amendedV2Criteria: CriteriaSnapshotItem[] = [
      {
        criterionId: "crit_v2_oauth",
        criterionType: "SPECIFICATION" as CriterionType,
        title: "V2 OAuth2 Spec",
        description: "OAuth2 PKCE flow",
        isMandatory: true,
        orderIndex: 1,
      },
    ];

    // Attempting to evaluate the submission using V2 criteria IDs must fail
    expect(() =>
      evaluatePolicy(submissionV1Snapshot, [
        { criterionId: "crit_v2_oauth", passed: true },
      ])
    ).toThrow(/Unknown criterion ID 'crit_v2_oauth'/);

    // Evaluating against the frozen submission snapshot succeeds completely
    const v1Assessments = [
      { criterionId: "crit_v1_auth", passed: true },
      { criterionId: "crit_v1_tests", passed: true },
    ];

    const result = evaluatePolicy(submissionV1Snapshot, v1Assessments);
    expect(result.decision).toBe("PASS");
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations[0]!.criterionId).toBe("crit_v1_auth");
    expect(result.evaluations[1]!.criterionId).toBe("crit_v1_tests");
  });

  it("Requirement 11: No AI or external dependency is needed to evaluate policy", () => {
    // Verify pure synchronous execution without mocks, promises, or network access
    const simpleSnapshot: CriteriaSnapshotItem[] = [
      {
        criterionId: "crit_simple",
        criterionType: "AUTOMATED_TEST" as CriterionType,
        title: "Simple Test",
        description: "Desc",
        isMandatory: true,
        orderIndex: 1,
      },
    ];

    const result = evaluatePolicy(simpleSnapshot, [
      { criterionId: "crit_simple", passed: true, evidence: { isolated: true } },
    ]);

    expect(result.decision).toBe("PASS");
    expect(result.evaluations[0]!.evidence).toEqual({ isolated: true });
  });

  describe("Requirement 12: Additional edge cases required by policy design", () => {
    it("reports multiple failed mandatory criteria in decisionReason", () => {
      const assessments = [
        {
          criterionId: "crit_001",
          passed: false,
          reason: "Tests timed out",
        },
        {
          criterionId: "crit_002",
          passed: false,
          reason: "ESLint found 14 errors",
        },
        {
          criterionId: "crit_003",
          passed: true,
        },
      ];

      const result = evaluatePolicy(sampleCriteriaSnapshot, assessments);

      expect(result.decision).toBe("FAIL");
      expect(result.summary.failedMandatory).toBe(2);
      expect(result.decisionReason).toContain("Unit Tests (crit_001) - Tests timed out");
      expect(result.decisionReason).toContain("ESLint & Typecheck (crit_002) - ESLint found 14 errors");
    });

    it("evaluates successfully when all criteria in snapshot are optional and all pass", () => {
      const allOptionalSnapshot: CriteriaSnapshotItem[] = [
        {
          criterionId: "crit_opt_1",
          criterionType: "SPECIFICATION" as CriterionType,
          title: "Optional A",
          description: "Desc A",
          isMandatory: false,
          orderIndex: 1,
        },
        {
          criterionId: "crit_opt_2",
          criterionType: "CODE_QUALITY" as CriterionType,
          title: "Optional B",
          description: "Desc B",
          isMandatory: false,
          orderIndex: 2,
        },
      ];

      const result = evaluatePolicy(allOptionalSnapshot, [
        { criterionId: "crit_opt_1", passed: true },
        { criterionId: "crit_opt_2", passed: true },
      ]);

      expect(result.decision).toBe("PASS");
      expect(result.summary.mandatoryCriteria).toBe(0);
      expect(result.summary.passedMandatory).toBe(0);
      expect(result.summary.optionalCriteria).toBe(2);
      expect(result.summary.passedOptional).toBe(2);
    });

    it("evaluates successfully when all criteria are optional and one fails (no mandatory criteria failed)", () => {
      const allOptionalSnapshot: CriteriaSnapshotItem[] = [
        {
          criterionId: "crit_opt_1",
          criterionType: "SPECIFICATION" as CriterionType,
          title: "Optional A",
          description: "Desc A",
          isMandatory: false,
          orderIndex: 1,
        },
        {
          criterionId: "crit_opt_2",
          criterionType: "CODE_QUALITY" as CriterionType,
          title: "Optional B",
          description: "Desc B",
          isMandatory: false,
          orderIndex: 2,
        },
      ];

      const result = evaluatePolicy(allOptionalSnapshot, [
        { criterionId: "crit_opt_1", passed: true },
        { criterionId: "crit_opt_2", passed: false, reason: "Advisory check not met" },
      ]);

      expect(result.decision).toBe("PASS");
      expect(result.decisionReason).toContain("1 optional criteria failed: Optional B (crit_opt_2)");
    });

    it("preserves empty evidence as plain object when evidence is omitted or null", () => {
      const singleSnapshot: CriteriaSnapshotItem[] = [
        {
          criterionId: "crit_single",
          criterionType: "AUTOMATED_TEST" as CriterionType,
          title: "Single",
          description: "Desc",
          isMandatory: true,
          orderIndex: 1,
        },
      ];

      const result = evaluatePolicy(singleSnapshot, [
        { criterionId: "crit_single", passed: true, evidence: null },
      ]);

      expect(result.evaluations[0]!.evidence).toEqual({});
    });

    it("sorts snapshot items deterministically when orderIndexes are not sequential", () => {
      const unsequencedSnapshot: CriteriaSnapshotItem[] = [
        {
          criterionId: "crit_100",
          criterionType: "SPECIFICATION" as CriterionType,
          title: "Order 100",
          description: "Desc",
          isMandatory: true,
          orderIndex: 100,
        },
        {
          criterionId: "crit_005",
          criterionType: "AUTOMATED_TEST" as CriterionType,
          title: "Order 5",
          description: "Desc",
          isMandatory: true,
          orderIndex: 5,
        },
        {
          criterionId: "crit_020",
          criterionType: "CODE_QUALITY" as CriterionType,
          title: "Order 20",
          description: "Desc",
          isMandatory: true,
          orderIndex: 20,
        },
      ];

      const result = evaluatePolicy(unsequencedSnapshot, [
        { criterionId: "crit_100", passed: true },
        { criterionId: "crit_020", passed: true },
        { criterionId: "crit_005", passed: true },
      ]);

      expect(result.evaluations.map((e) => e.criterionId)).toEqual([
        "crit_005",
        "crit_020",
        "crit_100",
      ]);
    });
  });
});
