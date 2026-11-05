import { describe, it, expect } from "vitest";
import {
  userSchema,
  contractSchema,
  milestoneSchema,
  acceptanceCriterionSchema,
  milestoneSubmissionSchema,
} from "../../src/modules/contracts/types";
import { paymentTransactionSchema } from "../../src/modules/payments/types";
import { policyEvaluationSchema } from "../../src/modules/policy/types";
import { auditLogSchema } from "../../src/modules/audit/types";

describe("Domain Models & Invariant Validation", () => {
  describe("User & Contract Entities", () => {
    it("validates a standard user", () => {
      const user = {
        id: "usr_1",
        email: "client@example.com",
        name: "Alice Client",
        role: "CLIENT" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(userSchema.parse(user)).toEqual(user);
    });

    it("enforces contract client != developer invariant", () => {
      const baseContract = {
        id: "cnt_1",
        title: "Web Platform Development",
        description: "Full-stack application",
        clientId: "usr_client",
        developerId: "usr_dev",
        githubRepoOwner: "test-org",
        githubRepoName: "test-repo",
        totalAmountMinorUnits: 150000n,
        currency: "USD" as const,
        status: "ACTIVE" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(contractSchema.parse(baseContract)).toEqual(baseContract);

      // Violate invariant: clientId === developerId
      expect(() =>
        contractSchema.parse({
          ...baseContract,
          developerId: "usr_client",
        })
      ).toThrow(/Contract clientId and developerId must be distinct actors/);
    });
  });

  describe("Milestone & AcceptanceCriterion", () => {
    it("validates milestone schema", () => {
      const milestone = {
        id: "mls_1",
        contractId: "cnt_1",
        title: "Milestone 1",
        description: "Setup and auth",
        amountMinorUnits: 50000n,
        currency: "USD" as const,
        status: "DRAFT" as const,
        activeCriteriaVersion: 1,
        orderIndex: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(milestoneSchema.parse(milestone)).toEqual(milestone);
    });

    it("rejects non-positive orderIndex or activeCriteriaVersion", () => {
      const milestone = {
        id: "mls_1",
        contractId: "cnt_1",
        title: "Milestone 1",
        description: "Setup and auth",
        amountMinorUnits: 50000n,
        currency: "USD" as const,
        status: "DRAFT" as const,
        activeCriteriaVersion: 0,
        orderIndex: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(() => milestoneSchema.parse(milestone)).toThrow();
    });

    it("validates acceptance criterion", () => {
      const criterion = {
        id: "crt_1",
        milestoneId: "mls_1",
        version: 1,
        orderIndex: 1,
        title: "Lint check",
        description: "All lint rules pass",
        criterionType: "CODE_QUALITY" as const,
        isMandatory: true,
        createdAt: new Date(),
      };
      expect(acceptanceCriterionSchema.parse(criterion)).toEqual(criterion);
    });
  });

  describe("MilestoneSubmission", () => {
    it("validates submission with 40-char SHA and 64-char criteriaHash", () => {
      const submission = {
        id: "sub_1",
        milestoneId: "mls_1",
        submissionNumber: 1,
        prNumber: 42,
        prCommitSha: "a1b2c3d4e5f6789012345678901234567890abcd",
        prUrl: "https://github.com/org/repo/pull/42",
        criteriaVersion: 1,
        criteriaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        status: "PENDING" as const,
        criteriaSnapshot: [
          {
            criterionId: "crt_1",
            criterionType: "AUTOMATED_TEST" as const,
            title: "Test suite",
            description: "All tests pass",
            isMandatory: true,
            orderIndex: 1,
          },
        ],
        submittedById: "usr_dev",
        submittedAt: new Date(),
      };
      expect(milestoneSubmissionSchema.parse(submission)).toEqual(submission);
    });

    it("rejects malformed commit SHA or criteriaHash", () => {
      const baseSubmission = {
        id: "sub_1",
        milestoneId: "mls_1",
        submissionNumber: 1,
        prNumber: 42,
        prCommitSha: "invalid-sha",
        prUrl: "https://github.com/org/repo/pull/42",
        criteriaVersion: 1,
        criteriaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        status: "PENDING" as const,
        criteriaSnapshot: [],
        submittedById: "usr_dev",
        submittedAt: new Date(),
      };
      expect(() => milestoneSubmissionSchema.parse(baseSubmission)).toThrow();
    });
  });

  describe("PaymentTransaction & Submission Invariant", () => {
    const validIdempotencyKey =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    it("allows PAYOUT when submissionId is provided", () => {
      const payoutTx = {
        id: "pay_1",
        milestoneId: "mls_1",
        submissionId: "sub_1",
        transactionType: "PAYOUT" as const,
        status: "RESERVED" as const,
        idempotencyKey: validIdempotencyKey,
        amountMinorUnits: 50000n,
        currency: "USD" as const,
        attemptNumber: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(paymentTransactionSchema.parse(payoutTx)).toEqual(payoutTx);
    });

    it("rejects PAYOUT when submissionId is null or omitted", () => {
      const invalidPayoutTx = {
        id: "pay_1",
        milestoneId: "mls_1",
        submissionId: null,
        transactionType: "PAYOUT" as const,
        status: "RESERVED" as const,
        idempotencyKey: validIdempotencyKey,
        amountMinorUnits: 50000n,
        currency: "USD" as const,
        attemptNumber: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(() => paymentTransactionSchema.parse(invalidPayoutTx)).toThrow(
        /PAYOUT transactions require a non-null submissionId/
      );
    });

    it("allows FUNDING_AUTHORIZATION and REFUND when submissionId is null", () => {
      const fundingTx = {
        id: "pay_fund",
        milestoneId: "mls_1",
        submissionId: null,
        transactionType: "FUNDING_AUTHORIZATION" as const,
        status: "SUCCEEDED" as const,
        idempotencyKey: validIdempotencyKey,
        amountMinorUnits: 50000n,
        currency: "USD" as const,
        attemptNumber: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(paymentTransactionSchema.parse(fundingTx)).toEqual(fundingTx);

      const refundTx = {
        ...fundingTx,
        id: "pay_ref",
        transactionType: "REFUND" as const,
      };
      expect(paymentTransactionSchema.parse(refundTx)).toEqual(refundTx);
    });

    it("rejects FUNDING_AUTHORIZATION or REFUND when submissionId is provided", () => {
      const invalidFunding = {
        id: "pay_fund",
        milestoneId: "mls_1",
        submissionId: "sub_1",
        transactionType: "FUNDING_AUTHORIZATION" as const,
        status: "SUCCEEDED" as const,
        idempotencyKey: validIdempotencyKey,
        amountMinorUnits: 50000n,
        currency: "USD" as const,
        attemptNumber: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(() => paymentTransactionSchema.parse(invalidFunding)).toThrow(
        /PAYOUT transactions require a non-null submissionId/
      );
    });
  });

  describe("PolicyEvaluation Completion Invariants", () => {
    const validHash =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    it("allows IN_PROGRESS evaluation without decision, completedAt, or evaluations", () => {
      const inProgress = {
        id: "pe_1",
        submissionId: "sub_1",
        milestoneId: "mls_1",
        criteriaHash: validHash,
        evaluationNumber: 1,
        policyVersion: "1.0.0",
        status: "IN_PROGRESS" as const,
        createdAt: new Date(),
      };
      expect(policyEvaluationSchema.parse(inProgress)).toEqual(inProgress);
    });

    it("allows COMPLETED evaluation with all required fields", () => {
      const completed = {
        id: "pe_1",
        submissionId: "sub_1",
        milestoneId: "mls_1",
        criteriaHash: validHash,
        evaluationNumber: 1,
        policyVersion: "1.0.0",
        status: "COMPLETED" as const,
        decision: "PASS" as const,
        completedAt: new Date(),
        evaluations: [
          {
            criterionId: "crt_1",
            criterionType: "COMMAND_EXIT_ZERO",
            passed: true,
            evidence: { stdout: "Passed" },
          },
        ],
        createdAt: new Date(),
      };
      expect(policyEvaluationSchema.parse(completed)).toEqual(completed);
    });

    it("rejects COMPLETED evaluation missing decision, completedAt, or evaluations", () => {
      const incomplete = {
        id: "pe_1",
        submissionId: "sub_1",
        milestoneId: "mls_1",
        criteriaHash: validHash,
        evaluationNumber: 1,
        policyVersion: "1.0.0",
        status: "COMPLETED" as const,
        decision: null,
        completedAt: null,
        evaluations: null,
        createdAt: new Date(),
      };
      expect(() => policyEvaluationSchema.parse(incomplete)).toThrow(
        /Completed policy evaluations must include decision/
      );
    });
  });

  describe("AuditLog Actor Mutual-Exclusion Invariant", () => {
    it("validates USER actor with actorUserId and without actorSystemPrincipal", () => {
      const userAudit = {
        id: "aud_1",
        entityType: "MILESTONE" as const,
        entityId: "mls_1",
        actorType: "USER" as const,
        actorUserId: "usr_client",
        action: "MILESTONE_FUNDED",
        correlationId: "corr_123",
        timestamp: new Date(),
      };
      expect(auditLogSchema.parse(userAudit)).toEqual(userAudit);
    });

    it("validates SYSTEM_PRINCIPAL actor with actorSystemPrincipal and without actorUserId", () => {
      const systemAudit = {
        id: "aud_2",
        entityType: "PAYMENT" as const,
        entityId: "pay_1",
        actorType: "SYSTEM_PRINCIPAL" as const,
        actorSystemPrincipal: "WORKER_PAYMENT_COORDINATOR",
        action: "PAYOUT_RESERVED",
        correlationId: "corr_123",
        timestamp: new Date(),
      };
      expect(auditLogSchema.parse(systemAudit)).toEqual(systemAudit);
    });

    it("rejects USER actor with missing actorUserId or present actorSystemPrincipal", () => {
      // Missing userId
      expect(() =>
        auditLogSchema.parse({
          id: "aud_1",
          entityType: "MILESTONE",
          entityId: "mls_1",
          actorType: "USER",
          action: "TEST",
          correlationId: "corr_1",
          timestamp: new Date(),
        })
      ).toThrow(/Mutual-exclusion violation/);

      // Present system principal with USER type
      expect(() =>
        auditLogSchema.parse({
          id: "aud_1",
          entityType: "MILESTONE",
          entityId: "mls_1",
          actorType: "USER",
          actorUserId: "usr_1",
          actorSystemPrincipal: "WORKER",
          action: "TEST",
          correlationId: "corr_1",
          timestamp: new Date(),
        })
      ).toThrow(/Mutual-exclusion violation/);
    });

    it("rejects non-USER actor with missing actorSystemPrincipal or present actorUserId", () => {
      // Missing principal
      expect(() =>
        auditLogSchema.parse({
          id: "aud_1",
          entityType: "PAYMENT",
          entityId: "pay_1",
          actorType: "SYSTEM_PRINCIPAL",
          action: "TEST",
          correlationId: "corr_1",
          timestamp: new Date(),
        })
      ).toThrow(/Mutual-exclusion violation/);

      // Present userId with SYSTEM_PRINCIPAL
      expect(() =>
        auditLogSchema.parse({
          id: "aud_1",
          entityType: "PAYMENT",
          entityId: "pay_1",
          actorType: "SYSTEM_PRINCIPAL",
          actorUserId: "usr_1",
          actorSystemPrincipal: "WORKER",
          action: "TEST",
          correlationId: "corr_1",
          timestamp: new Date(),
        })
      ).toThrow(/Mutual-exclusion violation/);
    });
  });
});
