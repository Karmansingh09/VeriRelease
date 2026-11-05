import { describe, it, expect } from "vitest";
import {
  ALLOWED_MILESTONE_TRANSITIONS,
  MILESTONE_TRANSITION_ACTORS,
  isMilestoneTransitionAllowed,
  transitionMilestone,
} from "../../src/modules/contracts/milestone-state-machine";
import {
  type Milestone,
  type MilestoneStatus,
  MILESTONE_STATUSES,
} from "../../src/modules/contracts/types";
import {
  InvalidStateTransitionError,
  UnauthorizedActorError,
  DomainValidationError,
} from "../../src/modules/common/errors";

function createMockMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "m_123",
    contractId: "c_456",
    title: "Milestone 1",
    description: "Initial deliverable",
    amountMinorUnits: 50000n,
    currency: "USD",
    status: "DRAFT",
    activeCriteriaVersion: 1,
    orderIndex: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Milestone State Machine", () => {
  it("defines exactly 8 verification-only states with zero payment state overlap", () => {
    expect(MILESTONE_STATUSES).toEqual([
      "DRAFT",
      "FUNDED",
      "SUBMITTED",
      "EVALUATING",
      "ELIGIBLE_FOR_PAYOUT",
      "CHANGES_REQUESTED",
      "DISPUTED",
      "CANCELLED",
    ]);

    // Ensure no payment states exist in milestone statuses
    const statuses = MILESTONE_STATUSES as readonly string[];
    expect(statuses).not.toContain("PAYMENT_PROCESSING");
    expect(statuses).not.toContain("PAID");
    expect(statuses).not.toContain("PROCESSING");
    expect(statuses).not.toContain("SUCCEEDED");
  });

  describe("isMilestoneTransitionAllowed", () => {
    it("allows valid transitions", () => {
      expect(isMilestoneTransitionAllowed("DRAFT", "FUNDED")).toBe(true);
      expect(isMilestoneTransitionAllowed("FUNDED", "SUBMITTED")).toBe(true);
      expect(isMilestoneTransitionAllowed("SUBMITTED", "EVALUATING")).toBe(true);
      expect(isMilestoneTransitionAllowed("EVALUATING", "ELIGIBLE_FOR_PAYOUT")).toBe(true);
      expect(isMilestoneTransitionAllowed("EVALUATING", "CHANGES_REQUESTED")).toBe(true);
      expect(isMilestoneTransitionAllowed("CHANGES_REQUESTED", "SUBMITTED")).toBe(true);
      expect(isMilestoneTransitionAllowed("ELIGIBLE_FOR_PAYOUT", "DISPUTED")).toBe(true);
    });

    it("disallows invalid transitions", () => {
      expect(isMilestoneTransitionAllowed("DRAFT", "SUBMITTED")).toBe(false);
      expect(isMilestoneTransitionAllowed("DRAFT", "ELIGIBLE_FOR_PAYOUT")).toBe(false);
      expect(isMilestoneTransitionAllowed("SUBMITTED", "ELIGIBLE_FOR_PAYOUT")).toBe(false);
      expect(isMilestoneTransitionAllowed("ELIGIBLE_FOR_PAYOUT", "SUBMITTED")).toBe(false);
    });

    it("enforces terminal states: DISPUTED and CANCELLED", () => {
      expect(ALLOWED_MILESTONE_TRANSITIONS.DISPUTED).toEqual([]);
      expect(ALLOWED_MILESTONE_TRANSITIONS.CANCELLED).toEqual([]);

      for (const target of MILESTONE_STATUSES) {
        expect(isMilestoneTransitionAllowed("DISPUTED", target)).toBe(false);
        expect(isMilestoneTransitionAllowed("CANCELLED", target)).toBe(false);
      }
    });
  });

  describe("transitionMilestone - Actor authorization & preconditions", () => {
    const validCommit = "a1b2c3d4e5f6789012345678901234567890abcd";
    const newCommit = "b2c3d4e5f6789012345678901234567890abcdef";
    const validDisputeReason = "Deliverable did not meet acceptance criteria: missing tests.";

    it("allows CLIENT to transition DRAFT -> FUNDED with valid positive activeCriteriaCount", () => {
      const milestone = createMockMilestone({ status: "DRAFT" });
      const result = transitionMilestone({
        milestone,
        targetStatus: "FUNDED",
        actor: "CLIENT",
        activeCriteriaCount: 2,
      });
      expect(result.newStatus).toBe("FUNDED");
    });

    it("rejects DRAFT -> FUNDED when activeCriteriaCount is missing", () => {
      const milestone = createMockMilestone({ status: "DRAFT" });
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "FUNDED",
          actor: "CLIENT",
        })
      ).toThrow(DomainValidationError);
    });

    it("rejects DRAFT -> FUNDED when activeCriteriaCount is zero", () => {
      const milestone = createMockMilestone({ status: "DRAFT" });
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "FUNDED",
          actor: "CLIENT",
          activeCriteriaCount: 0,
        })
      ).toThrow(DomainValidationError);
    });

    it("rejects DRAFT -> FUNDED when activeCriteriaCount is negative", () => {
      const milestone = createMockMilestone({ status: "DRAFT" });
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "FUNDED",
          actor: "CLIENT",
          activeCriteriaCount: -1,
        })
      ).toThrow(DomainValidationError);
    });

    it("rejects DRAFT -> FUNDED when milestone amount is zero or negative", () => {
      const zeroMilestone = createMockMilestone({ status: "DRAFT", amountMinorUnits: 0n });
      expect(() =>
        transitionMilestone({
          milestone: zeroMilestone,
          targetStatus: "FUNDED",
          actor: "CLIENT",
          activeCriteriaCount: 1,
        })
      ).toThrow(DomainValidationError);

      const negativeMilestone = createMockMilestone({ status: "DRAFT", amountMinorUnits: -100n });
      expect(() =>
        transitionMilestone({
          milestone: negativeMilestone,
          targetStatus: "FUNDED",
          actor: "CLIENT",
          activeCriteriaCount: 1,
        })
      ).toThrow(DomainValidationError);
    });

    it("rejects non-CLIENT transitioning DRAFT -> FUNDED", () => {
      const milestone = createMockMilestone({ status: "DRAFT" });
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "FUNDED",
          actor: "DEVELOPER",
          activeCriteriaCount: 1,
        })
      ).toThrow(UnauthorizedActorError);
    });

    it("allows DEVELOPER to submit work (FUNDED -> SUBMITTED) with valid SHA and PR", () => {
      const milestone = createMockMilestone({ status: "FUNDED" });
      const result = transitionMilestone({
        milestone,
        targetStatus: "SUBMITTED",
        actor: "DEVELOPER",
        prCommitSha: validCommit,
        prNumber: 42,
      });
      expect(result.newStatus).toBe("SUBMITTED");
    });

    it("rejects FUNDED -> SUBMITTED without commitSha or prNumber", () => {
      const milestone = createMockMilestone({ status: "FUNDED" });
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "SUBMITTED",
          actor: "DEVELOPER",
          prNumber: 42,
        })
      ).toThrow(DomainValidationError);

      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "SUBMITTED",
          actor: "DEVELOPER",
          prCommitSha: "invalid-sha",
          prNumber: 42,
        })
      ).toThrow(DomainValidationError);

      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "SUBMITTED",
          actor: "DEVELOPER",
          prCommitSha: validCommit,
          prNumber: 0,
        })
      ).toThrow(DomainValidationError);
    });

    it("authorizes ONLY SYSTEM for SUBMITTED -> EVALUATING", () => {
      const milestone = createMockMilestone({ status: "SUBMITTED" });
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "EVALUATING",
          actor: "CLIENT",
        })
      ).toThrow(UnauthorizedActorError);

      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "EVALUATING",
          actor: "DEVELOPER",
        })
      ).toThrow(UnauthorizedActorError);

      const result = transitionMilestone({
        milestone,
        targetStatus: "EVALUATING",
        actor: "SYSTEM",
      });
      expect(result.newStatus).toBe("EVALUATING");
    });

    it("authorizes ONLY SYSTEM for EVALUATING -> ELIGIBLE_FOR_PAYOUT", () => {
      const milestone = createMockMilestone({ status: "EVALUATING" });
      const result = transitionMilestone({
        milestone,
        targetStatus: "ELIGIBLE_FOR_PAYOUT",
        actor: "SYSTEM",
      });
      expect(result.newStatus).toBe("ELIGIBLE_FOR_PAYOUT");
    });

    it("authorizes ONLY SYSTEM for EVALUATING -> CHANGES_REQUESTED", () => {
      const milestone = createMockMilestone({ status: "EVALUATING" });
      const result = transitionMilestone({
        milestone,
        targetStatus: "CHANGES_REQUESTED",
        actor: "SYSTEM",
      });
      expect(result.newStatus).toBe("CHANGES_REQUESTED");
    });

    describe("Resubmission (CHANGES_REQUESTED -> SUBMITTED) priorCommitSha validation", () => {
      it("rejects resubmission when priorCommitSha is missing", () => {
        const milestone = createMockMilestone({ status: "CHANGES_REQUESTED" });
        expect(() =>
          transitionMilestone({
            milestone,
            targetStatus: "SUBMITTED",
            actor: "DEVELOPER",
            prCommitSha: newCommit,
            prNumber: 42,
          })
        ).toThrow(DomainValidationError);
      });

      it("rejects resubmission when priorCommitSha is malformed (not 40-char hex)", () => {
        const milestone = createMockMilestone({ status: "CHANGES_REQUESTED" });
        expect(() =>
          transitionMilestone({
            milestone,
            targetStatus: "SUBMITTED",
            actor: "DEVELOPER",
            prCommitSha: newCommit,
            priorCommitSha: "not-a-valid-sha",
            prNumber: 42,
          })
        ).toThrow(DomainValidationError);

        expect(() =>
          transitionMilestone({
            milestone,
            targetStatus: "SUBMITTED",
            actor: "DEVELOPER",
            prCommitSha: newCommit,
            priorCommitSha: "a1b2c3", // too short
            prNumber: 42,
          })
        ).toThrow(DomainValidationError);
      });

      it("rejects resubmission when priorCommitSha and prCommitSha are identical", () => {
        const milestone = createMockMilestone({ status: "CHANGES_REQUESTED" });
        expect(() =>
          transitionMilestone({
            milestone,
            targetStatus: "SUBMITTED",
            actor: "DEVELOPER",
            prCommitSha: validCommit,
            priorCommitSha: validCommit,
            prNumber: 42,
          })
        ).toThrow(DomainValidationError);

        // Case-insensitive comparison
        expect(() =>
          transitionMilestone({
            milestone,
            targetStatus: "SUBMITTED",
            actor: "DEVELOPER",
            prCommitSha: validCommit.toLowerCase(),
            priorCommitSha: validCommit.toUpperCase(),
            prNumber: 42,
          })
        ).toThrow(DomainValidationError);
      });

      it("accepts resubmission when priorCommitSha and prCommitSha are different valid 40-char hex SHAs", () => {
        const milestone = createMockMilestone({ status: "CHANGES_REQUESTED" });
        const result = transitionMilestone({
          milestone,
          targetStatus: "SUBMITTED",
          actor: "DEVELOPER",
          prCommitSha: newCommit,
          priorCommitSha: validCommit,
          prNumber: 42,
        });
        expect(result.newStatus).toBe("SUBMITTED");
      });
    });

    it("requires dispute reason of at least 20 characters when transitioning to DISPUTED", () => {
      const milestone = createMockMilestone({ status: "FUNDED" });

      // Reject too short dispute reason
      expect(() =>
        transitionMilestone({
          milestone,
          targetStatus: "DISPUTED",
          actor: "CLIENT",
          disputeReason: "Not satisfied", // 13 chars
        })
      ).toThrow(DomainValidationError);

      // Accept >= 20 characters
      const result = transitionMilestone({
        milestone,
        targetStatus: "DISPUTED",
        actor: "CLIENT",
        disputeReason: validDisputeReason,
      });
      expect(result.newStatus).toBe("DISPUTED");
    });

    it("throws InvalidStateTransitionError when transitioning from terminal states", () => {
      const disputedMilestone = createMockMilestone({ status: "DISPUTED" });
      expect(() =>
        transitionMilestone({
          milestone: disputedMilestone,
          targetStatus: "FUNDED",
          actor: "CLIENT",
        })
      ).toThrow(InvalidStateTransitionError);

      const cancelledMilestone = createMockMilestone({ status: "CANCELLED" });
      expect(() =>
        transitionMilestone({
          milestone: cancelledMilestone,
          targetStatus: "DRAFT",
          actor: "CLIENT",
        })
      ).toThrow(InvalidStateTransitionError);
    });
  });
});
