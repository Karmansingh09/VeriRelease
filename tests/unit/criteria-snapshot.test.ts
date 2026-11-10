import { describe, it, expect } from "vitest";
import { canonicalizeJson, hashCanonicalJson, sha256Hex } from "../../src/modules/common/canonical-json";
import type { CriteriaSnapshotItem, CriterionType } from "../../src/modules/contracts/types";

describe("Acceptance Criteria Snapshot & RFC 8785 Canonical Hashing Unit Tests", () => {
  const sampleCriteria: CriteriaSnapshotItem[] = [
    {
      criterionId: "crit_001",
      criterionType: "AUTOMATED_TEST" as CriterionType,
      description: "All unit tests in tests/unit must pass cleanly",
      isMandatory: true,
      orderIndex: 1,
      title: "Pass unit test suite",
    },
    {
      criterionId: "crit_002",
      criterionType: "CODE_QUALITY" as CriterionType,
      description: "ESLint and typecheck must report zero warnings or errors",
      isMandatory: true,
      orderIndex: 2,
      title: "Code quality checks",
    },
  ];

  it("produces deterministic RFC 8785 canonical JSON string", () => {
    const canonical = canonicalizeJson(sampleCriteria);

    // In RFC 8785, keys of each object must be sorted by UTF-16 code units:
    // "criterionId", "criterionType", "description", "isMandatory", "orderIndex", "title"
    expect(canonical).toBe(
      '[{"criterionId":"crit_001","criterionType":"AUTOMATED_TEST","description":"All unit tests in tests/unit must pass cleanly","isMandatory":true,"orderIndex":1,"title":"Pass unit test suite"},{"criterionId":"crit_002","criterionType":"CODE_QUALITY","description":"ESLint and typecheck must report zero warnings or errors","isMandatory":true,"orderIndex":2,"title":"Code quality checks"}]'
    );
  });

  it("produces identical 64-hex SHA-256 digest regardless of object key insertion order", () => {
    // Construct same items with shuffled key insertion order
    const shuffledOrder: CriteriaSnapshotItem[] = [
      {
        title: "Pass unit test suite",
        orderIndex: 1,
        isMandatory: true,
        description: "All unit tests in tests/unit must pass cleanly",
        criterionType: "AUTOMATED_TEST" as CriterionType,
        criterionId: "crit_001",
      },
      {
        isMandatory: true,
        title: "Code quality checks",
        criterionId: "crit_002",
        criterionType: "CODE_QUALITY" as CriterionType,
        orderIndex: 2,
        description: "ESLint and typecheck must report zero warnings or errors",
      },
    ];

    const hash1 = hashCanonicalJson(sampleCriteria);
    const hash2 = hashCanonicalJson(shuffledOrder);

    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
  });

  it("produces different hash if any criterion attribute is altered", () => {
    const baselineHash = hashCanonicalJson(sampleCriteria);

    // Alter description
    const altered1 = [
      { ...sampleCriteria[0]!, description: "Modified description" },
      sampleCriteria[1]!,
    ];
    expect(hashCanonicalJson(altered1)).not.toBe(baselineHash);

    // Alter mandatory flag
    const altered2 = [
      { ...sampleCriteria[0]!, isMandatory: false },
      sampleCriteria[1]!,
    ];
    expect(hashCanonicalJson(altered2)).not.toBe(baselineHash);

    // Alter order
    const altered3 = [sampleCriteria[1]!, sampleCriteria[0]!];
    expect(hashCanonicalJson(altered3)).not.toBe(baselineHash);
  });

  it("computes exact SHA-256 digest of canonical bytes", () => {
    const canonical = canonicalizeJson(sampleCriteria);
    const expectedHash = sha256Hex(canonical);
    const actualHash = hashCanonicalJson(sampleCriteria);

    expect(actualHash).toBe(expectedHash);
  });
});
