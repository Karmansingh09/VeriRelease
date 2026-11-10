/**
 * ContractService Unit Test Suite
 *
 * Covers:
 * - Contract creation and actor authorization
 * - Milestone creation with acceptance criteria
 * - Acceptance criteria validation
 * - Milestone funding (DRAFT -> FUNDED)
 * - Work submission (FUNDED -> SUBMITTED) with immutable criteria snapshot
 * - Changes requested (SUBMITTED -> CHANGES_REQUESTED)
 * - Work resubmission (CHANGES_REQUESTED -> SUBMITTED)
 * - Unauthorized access rejection (forbidden actors)
 * - Invalid state transitions rejection
 * - Audit logging verification
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContractService } from "../../src/modules/contracts/contract-service";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainValidationError,
  DomainConflictError,
  InvalidStateTransitionError,
} from "../../src/modules/common/errors";

describe("ContractService Unit Tests", () => {
  let mockContractRepo: any;
  let mockMilestoneRepo: any;
  let mockSubmissionRepo: any;
  let mockAuditService: any;
  let mockDb: any;
  let contractService: ContractService;

  const clientUser = {
    id: "usr_client_1",
    email: "client@example.com",
    name: "Alice Client",
    role: "CLIENT",
    isActive: true,
  };

  const devUser = {
    id: "usr_dev_1",
    email: "dev@example.com",
    name: "Bob Developer",
    role: "DEVELOPER",
    githubUsername: "bobdev",
    isActive: true,
  };

  const sampleContract = {
    id: "cnt_1",
    title: "E-Commerce Integration",
    description: "Build PayPal checkout and backend verification",
    clientId: clientUser.id,
    developerId: devUser.id,
    status: "DRAFT" as const,
    totalAmountMinorUnits: 250000n,
    currency: "USD" as const,
    githubRepoOwner: "alicecorp",
    githubRepoName: "ecommerce-web",
    createdAt: new Date(),
    updatedAt: new Date(),
    client: clientUser,
    developer: devUser,
    milestones: [],
  };

  const sampleMilestone = {
    id: "mls_1",
    contractId: sampleContract.id,
    title: "Milestone 1: Webhook Handling",
    description: "Implement secure webhook delivery",
    orderIndex: 1,
    amountMinorUnits: 100000n,
    currency: "USD" as const,
    status: "DRAFT" as const,
    activeCriteriaVersion: 1,
    fundedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    criteria: [
      {
        id: "crit_1",
        milestoneId: "mls_1",
        version: 1,
        orderIndex: 1,
        title: "Signature Verification",
        description: "Validates HMAC signature",
        criterionType: "AUTOMATED_TEST" as const,
        isMandatory: true,
        createdAt: new Date(),
      },
    ],
  };

  beforeEach(() => {
    mockContractRepo = {
      create: vi.fn().mockResolvedValue(sampleContract),
      findById: vi.fn(),
      findByIdWithMilestones: vi.fn(),
      findByParticipant: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue({ ...sampleContract, status: "ACTIVE" }),
    };

    mockMilestoneRepo = {
      create: vi.fn().mockResolvedValue(sampleMilestone),
      findById: vi.fn(),
      findByIdWithCriteria: vi.fn(),
      findByContractId: vi.fn(),
      updateStatus: vi.fn(),
    };

    mockSubmissionRepo = {
      createSubmission: vi.fn(),
      findById: vi.fn(),
      findByMilestoneId: vi.fn(),
      findLatestByMilestoneId: vi.fn(),
    };

    mockAuditService = {
      recordEvent: vi.fn().mockResolvedValue({
        auditLog: { id: "aud_1", action: "AUDIT_RECORDED" },
        eventHash: "a".repeat(64),
      }),
    };

    mockDb = {
      user: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          if (where.id === clientUser.id) return Promise.resolve(clientUser);
          if (where.id === devUser.id) return Promise.resolve(devUser);
          if (where.email === devUser.email) return Promise.resolve(devUser);
          return Promise.resolve(null);
        }),
        findFirst: vi.fn().mockImplementation(({ where }) => {
          if (where.githubUsername === devUser.githubUsername) return Promise.resolve(devUser);
          return Promise.resolve(null);
        }),
        findMany: vi.fn().mockResolvedValue([clientUser, devUser]),
        create: vi.fn(),
      },
      contract: {
        findUnique: vi.fn().mockResolvedValue(sampleContract),
        findMany: vi.fn().mockResolvedValue([sampleContract]),
      },
      milestone: {
        findUnique: vi.fn().mockResolvedValue({
          ...sampleMilestone,
          contract: sampleContract,
        }),
      },
      acceptanceCriterion: {
        count: vi.fn().mockResolvedValue(1),
      },
      auditLog: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    contractService = new ContractService(
      mockContractRepo,
      mockMilestoneRepo,
      mockSubmissionRepo,
      mockAuditService,
      mockDb as any
    );
  });

  describe("Contract Creation", () => {
    it("successfully creates a contract when caller is active and developer is resolved", async () => {
      const contract = await contractService.createContract(clientUser.id, {
        title: "Test Contract",
        description: "Test Description",
        developerId: devUser.id,
        githubRepoOwner: "alicecorp",
        githubRepoName: "ecommerce-web",
        totalAmountUsd: 2500,
      });

      expect(contract.id).toBe(sampleContract.id);
      expect(mockContractRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: clientUser.id,
          developerId: devUser.id,
          totalAmountMinorUnits: 250000n,
          currency: "USD",
        })
      );

      // Verifies audit event
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "CONTRACT",
          entityId: sampleContract.id,
          actorType: "USER",
          actorUserId: clientUser.id,
          action: "CONTRACT_CREATED",
        })
      );
    });

    it("resolves developer by email if developerId is not provided", async () => {
      await contractService.createContract(clientUser.id, {
        title: "Test Contract",
        description: "Test Description",
        developerEmail: devUser.email,
        githubRepoOwner: "alicecorp",
        githubRepoName: "ecommerce-web",
      });

      expect(mockContractRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          developerId: devUser.id,
        })
      );
    });

    it("rejects contract creation when client and developer are the same actor", async () => {
      await expect(
        contractService.createContract(clientUser.id, {
          title: "Test Contract",
          description: "Test Description",
          developerId: clientUser.id,
          githubRepoOwner: "alicecorp",
          githubRepoName: "ecommerce-web",
        })
      ).rejects.toThrow(DomainValidationError);
    });

    it("rejects contract creation if caller does not exist or is inactive", async () => {
      mockDb.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        contractService.createContract("usr_ghost", {
          title: "Test Contract",
          description: "Test Description",
          developerId: devUser.id,
          githubRepoOwner: "alicecorp",
          githubRepoName: "ecommerce-web",
        })
      ).rejects.toThrow(DomainForbiddenError);
    });
  });

  describe("Milestone Addition", () => {
    it("allows the contract client to add a milestone with acceptance criteria", async () => {
      mockDb.contract.findUnique.mockResolvedValueOnce({
        ...sampleContract,
        milestones: [{ orderIndex: 1 }],
      });

      const milestone = await contractService.addMilestone(sampleContract.id, clientUser.id, {
        title: "Milestone 2: Security Audit",
        description: "Perform comprehensive security audit",
        amountUsd: 1500,
        criteria: [
          {
            title: "CSRF Defense",
            description: "Enforce origin matching",
            criterionType: "AUTOMATED_TEST",
            isMandatory: true,
          },
        ],
      });

      expect(milestone.id).toBe(sampleMilestone.id);
      expect(mockMilestoneRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: sampleContract.id,
          orderIndex: 2,
          amountMinorUnits: 150000n,
          criteria: [
            expect.objectContaining({
              title: "CSRF Defense",
              criterionType: "AUTOMATED_TEST",
            }),
          ],
        })
      );

      // Verifies audit event
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "MILESTONE",
          entityId: sampleMilestone.id,
          actorUserId: clientUser.id,
          action: "MILESTONE_CREATED",
        })
      );
    });

    it("rejects milestone addition by unauthorized developer or third party", async () => {
      mockDb.contract.findUnique.mockResolvedValueOnce(sampleContract);

      await expect(
        contractService.addMilestone(sampleContract.id, devUser.id, {
          title: "Unauthorized Milestone",
          description: "Should fail",
        })
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("rejects milestone addition if contract is CANCELLED or COMPLETED", async () => {
      mockDb.contract.findUnique.mockResolvedValueOnce({
        ...sampleContract,
        status: "COMPLETED",
      });

      await expect(
        contractService.addMilestone(sampleContract.id, clientUser.id, {
          title: "Late Milestone",
          description: "Should fail",
        })
      ).rejects.toThrow(DomainConflictError);
    });
  });

  describe("Milestone Funding Lifecycle (DRAFT -> FUNDED)", () => {
    it("allows client to fund a DRAFT milestone and activates the contract", async () => {
      mockMilestoneRepo.updateStatus.mockResolvedValueOnce({
        ...sampleMilestone,
        status: "FUNDED",
        fundedAt: new Date(),
      });

      const updated = await contractService.fundMilestone(sampleMilestone.id, clientUser.id);

      expect(updated.status).toBe("FUNDED");
      expect(mockMilestoneRepo.updateStatus).toHaveBeenCalledWith(
        sampleMilestone.id,
        "FUNDED",
        expect.any(Date)
      );

      // Verifies contract activation
      expect(mockContractRepo.updateStatus).toHaveBeenCalledWith(sampleContract.id, "ACTIVE");

      // Verifies audit event
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "MILESTONE",
          entityId: sampleMilestone.id,
          action: "MILESTONE_FUNDED",
        })
      );
    });

    it("rejects funding by non-client user", async () => {
      await expect(
        contractService.fundMilestone(sampleMilestone.id, devUser.id)
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("rejects funding if milestone is already FUNDED or SUBMITTED", async () => {
      mockDb.milestone.findUnique.mockResolvedValueOnce({
        ...sampleMilestone,
        status: "FUNDED",
        contract: sampleContract,
      });

      await expect(
        contractService.fundMilestone(sampleMilestone.id, clientUser.id)
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe("Milestone Work Submission (FUNDED -> SUBMITTED)", () => {
    it("allows assigned developer to submit PR deliverable", async () => {
      const mockSubmission = {
        id: "sub_1",
        milestoneId: sampleMilestone.id,
        submissionNumber: 1,
        prNumber: 42,
        prCommitSha: "a".repeat(40),
        prUrl: "https://github.com/alicecorp/ecommerce-web/pull/42",
        criteriaVersion: 1,
        criteriaSnapshot: [],
        criteriaHash: "b".repeat(64),
        status: "PENDING",
        submittedById: devUser.id,
        submittedAt: new Date(),
      };

      mockSubmissionRepo.createSubmission.mockResolvedValueOnce(mockSubmission);

      const submission = await contractService.submitMilestoneWork(
        sampleMilestone.id,
        devUser.id,
        {
          prNumber: 42,
          prCommitSha: "a".repeat(40),
          prUrl: "https://github.com/alicecorp/ecommerce-web/pull/42",
        }
      );

      expect(submission.id).toBe("sub_1");
      expect(mockSubmissionRepo.createSubmission).toHaveBeenCalledWith({
        milestoneId: sampleMilestone.id,
        prNumber: 42,
        prCommitSha: "a".repeat(40),
        prUrl: "https://github.com/alicecorp/ecommerce-web/pull/42",
        submittedById: devUser.id,
      });

      // Verifies audit event
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "SUBMISSION",
          entityId: "sub_1",
          actorUserId: devUser.id,
          action: "MILESTONE_SUBMITTED",
        })
      );
    });

    it("rejects submission by client or unauthorized user", async () => {
      await expect(
        contractService.submitMilestoneWork(sampleMilestone.id, clientUser.id, {
          prNumber: 42,
          prCommitSha: "a".repeat(40),
          prUrl: "https://github.com/alicecorp/ecommerce-web/pull/42",
        })
      ).rejects.toThrow(DomainForbiddenError);
    });
  });

  describe("Change Requests & Resubmission (SUBMITTED -> CHANGES_REQUESTED -> SUBMITTED)", () => {
    it("allows client to request changes on submitted milestone", async () => {
      mockDb.milestone.findUnique.mockResolvedValueOnce({
        ...sampleMilestone,
        status: "SUBMITTED",
        contract: sampleContract,
      });

      mockMilestoneRepo.updateStatus.mockResolvedValueOnce({
        ...sampleMilestone,
        status: "CHANGES_REQUESTED",
      });

      const updated = await contractService.requestChanges(
        sampleMilestone.id,
        clientUser.id,
        "Please fix the failing linting rules and add unit tests"
      );

      expect(updated.status).toBe("CHANGES_REQUESTED");
      expect(mockMilestoneRepo.updateStatus).toHaveBeenCalledWith(
        sampleMilestone.id,
        "CHANGES_REQUESTED"
      );

      // Verifies audit event
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "MILESTONE",
          entityId: sampleMilestone.id,
          action: "CHANGES_REQUESTED",
          metadata: expect.objectContaining({
            reason: "Please fix the failing linting rules and add unit tests",
          }),
        })
      );
    });

    it("rejects change request by developer", async () => {
      mockDb.milestone.findUnique.mockResolvedValueOnce({
        ...sampleMilestone,
        status: "SUBMITTED",
        contract: sampleContract,
      });

      await expect(
        contractService.requestChanges(
          sampleMilestone.id,
          devUser.id,
          "Self change request"
        )
      ).rejects.toThrow(DomainForbiddenError);
    });

    it("rejects change request when milestone is in DRAFT status", async () => {
      mockDb.milestone.findUnique.mockResolvedValueOnce({
        ...sampleMilestone,
        status: "DRAFT",
        contract: sampleContract,
      });

      await expect(
        contractService.requestChanges(
          sampleMilestone.id,
          clientUser.id,
          "Cannot request changes on draft"
        )
      ).rejects.toThrow(DomainConflictError);
    });

    it("allows developer to resubmit work after changes requested", async () => {
      const mockResubmission = {
        id: "sub_2",
        milestoneId: sampleMilestone.id,
        submissionNumber: 2,
        prNumber: 42,
        prCommitSha: "c".repeat(40),
        prUrl: "https://github.com/alicecorp/ecommerce-web/pull/42",
        criteriaVersion: 1,
        criteriaSnapshot: [],
        criteriaHash: "d".repeat(64),
        status: "PENDING",
        submittedById: devUser.id,
        submittedAt: new Date(),
      };

      mockSubmissionRepo.createSubmission.mockResolvedValueOnce(mockResubmission);

      const resubmission = await contractService.submitMilestoneWork(
        sampleMilestone.id,
        devUser.id,
        {
          prNumber: 42,
          prCommitSha: "c".repeat(40),
          prUrl: "https://github.com/alicecorp/ecommerce-web/pull/42",
        }
      );

      expect(resubmission.submissionNumber).toBe(2);

      // Verifies audit event MILESTONE_RESUBMITTED
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "SUBMISSION",
          entityId: "sub_2",
          action: "MILESTONE_RESUBMITTED",
        })
      );
    });
  });

  describe("Contract and Milestone Details Authorization", () => {
    it("allows participants (client and developer) to view contract details", async () => {
      const clientView = await contractService.getContractById(sampleContract.id, clientUser.id);
      expect(clientView.id).toBe(sampleContract.id);

      const devView = await contractService.getContractById(sampleContract.id, devUser.id);
      expect(devView.id).toBe(sampleContract.id);
    });

    it("rejects third-party user from viewing contract details", async () => {
      await expect(
        contractService.getContractById(sampleContract.id, "usr_third_party")
      ).rejects.toThrow(DomainForbiddenError);
    });
  });
});
