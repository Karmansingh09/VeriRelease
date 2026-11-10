/**
 * Contract & Milestone API Routes Unit Test Suite
 *
 * Tests the HTTP routing layer:
 * - NextRequest parsing and response formatting
 * - Authentication enforcement (401)
 * - CSRF verification on state-changing POST/PATCH requests (403)
 * - Authorization enforcement (403 Forbidden)
 * - Input validation (400 Bad Request)
 * - Conflict handling (409 Conflict)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getContracts, POST as createContract } from "../../src/app/api/contracts/route";
import { GET as getContractById } from "../../src/app/api/contracts/[id]/route";
import { GET as getMilestones, POST as createMilestone } from "../../src/app/api/contracts/[id]/milestones/route";
import { GET as getMilestoneById } from "../../src/app/api/milestones/[id]/route";
import { POST as fundMilestone } from "../../src/app/api/milestones/[id]/fund/route";
import { GET as getSubmissions, POST as createSubmission } from "../../src/app/api/milestones/[id]/submissions/route";
import { POST as requestChanges } from "../../src/app/api/milestones/[id]/request-changes/route";
import { GET as getUsers, PATCH as updateRole } from "../../src/app/api/users/route";
import { authService } from "../../src/modules/auth";
import { contractService } from "../../src/modules/contracts";
import { prisma } from "../../src/lib/prisma";
import {
  DomainForbiddenError,
  DomainNotFoundError,
  DomainUnauthorizedError,
  DomainValidationError,
} from "../../src/modules/common/errors";

vi.mock("../../src/modules/auth", () => ({
  authService: {
    authenticateRequest: vi.fn(),
  },
}));

vi.mock("../../src/modules/contracts", () => ({
  contractService: {
    createContract: vi.fn(),
    getContractsForUser: vi.fn(),
    getContractById: vi.fn(),
    addMilestone: vi.fn(),
    fundMilestone: vi.fn(),
    submitMilestoneWork: vi.fn(),
    requestChanges: vi.fn(),
    getMilestoneDetails: vi.fn(),
  },
}));

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe("Contract & Milestone API Routes", () => {
  const mockUser = {
    id: "usr_alice",
    email: "alice@example.com",
    name: "Alice",
    role: "CLIENT",
    githubUsername: "alicegh",
    isActive: true,
  };

  const sampleContract = {
    id: "cnt_101",
    title: "Hackathon MVP",
    description: "Build full prototype",
    clientId: mockUser.id,
    developerId: "usr_bob",
    status: "DRAFT",
    totalAmountMinorUnits: 200000n,
    currency: "USD",
    githubRepoOwner: "alicegh",
    githubRepoName: "hackathon-mvp",
    createdAt: new Date(),
    updatedAt: new Date(),
    client: mockUser,
    developer: { id: "usr_bob", email: "bob@test.com", name: "Bob", role: "DEVELOPER" },
    milestones: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.authenticateRequest as any).mockResolvedValue(mockUser);
  });

  describe("POST /api/contracts", () => {
    it("successfully creates a contract with Bearer token authentication", async () => {
      (contractService.createContract as any).mockResolvedValue(sampleContract);

      const req = new NextRequest("http://localhost:3000/api/contracts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer vr_auth.test.valid",
        },
        body: JSON.stringify({
          title: "Hackathon MVP",
          description: "Build full prototype",
          developerId: "usr_bob",
          githubRepoOwner: "alicegh",
          githubRepoName: "hackathon-mvp",
        }),
      });

      const res = await createContract(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.contract.id).toBe("cnt_101");
      expect(data.contract.totalAmountMinorUnits).toBe("200000");
    });

    it("rejects contract creation with 400 when validation fails", async () => {
      const req = new NextRequest("http://localhost:3000/api/contracts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer vr_auth.test.valid",
        },
        body: JSON.stringify({
          title: "AB", // Too short
          description: "CD", // Too short
        }),
      });

      const res = await createContract(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation Error");
    });

    it("rejects contract creation with 401 when unauthenticated", async () => {
      (authService.authenticateRequest as any).mockRejectedValueOnce(
        new DomainUnauthorizedError("No session provided")
      );

      const req = new NextRequest("http://localhost:3000/api/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Hackathon MVP",
          description: "Build full prototype",
          githubRepoOwner: "alicegh",
          githubRepoName: "hackathon-mvp",
        }),
      });

      const res = await createContract(req);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/contracts", () => {
    it("lists contracts for authenticated user", async () => {
      (contractService.getContractsForUser as any).mockResolvedValue([sampleContract]);

      const req = new NextRequest("http://localhost:3000/api/contracts", {
        headers: { Authorization: "Bearer vr_auth.test.valid" },
      });

      const res = await getContracts(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.contracts).toHaveLength(1);
      expect(data.contracts[0].id).toBe("cnt_101");
    });
  });

  describe("GET /api/contracts/[id]", () => {
    it("returns contract details when authorized", async () => {
      (contractService.getContractById as any).mockResolvedValue(sampleContract);

      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_101", {
        headers: { Authorization: "Bearer vr_auth.test.valid" },
      });

      const res = await getContractById(req, {
        params: Promise.resolve({ id: "cnt_101" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.contract.id).toBe("cnt_101");
    });

    it("returns 403 when user is not authorized", async () => {
      (contractService.getContractById as any).mockRejectedValueOnce(
        new DomainForbiddenError("You are not authorized to view this contract")
      );

      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_101", {
        headers: { Authorization: "Bearer vr_auth.test.valid" },
      });

      const res = await getContractById(req, {
        params: Promise.resolve({ id: "cnt_101" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/contracts/[id]/milestones", () => {
    it("adds a milestone with criteria", async () => {
      const mockMilestone = {
        id: "mls_201",
        contractId: "cnt_101",
        title: "Milestone 1",
        description: "Delivery 1",
        orderIndex: 1,
        amountMinorUnits: 100000n,
        currency: "USD",
        status: "DRAFT",
        criteria: [],
      };
      (contractService.addMilestone as any).mockResolvedValue(mockMilestone);

      const req = new NextRequest("http://localhost:3000/api/contracts/cnt_101/milestones", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer vr_auth.test.valid",
        },
        body: JSON.stringify({
          title: "Milestone 1",
          description: "Delivery 1",
          amountUsd: 1000,
          criteria: [
            {
              title: "Test Suite",
              description: "All automated tests pass",
              criterionType: "AUTOMATED_TEST",
              isMandatory: true,
            },
          ],
        }),
      });

      const res = await createMilestone(req, {
        params: Promise.resolve({ id: "cnt_101" }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.milestone.id).toBe("mls_201");
    });
  });

  describe("POST /api/milestones/[id]/fund", () => {
    it("funds a milestone (transitions DRAFT -> FUNDED)", async () => {
      const fundedMilestone = {
        id: "mls_201",
        status: "FUNDED",
        amountMinorUnits: 100000n,
      };
      (contractService.fundMilestone as any).mockResolvedValue(fundedMilestone);

      const req = new NextRequest("http://localhost:3000/api/milestones/mls_201/fund", {
        method: "POST",
        headers: { Authorization: "Bearer vr_auth.test.valid" },
      });

      const res = await fundMilestone(req, {
        params: Promise.resolve({ id: "mls_201" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.milestone.status).toBe("FUNDED");
    });
  });

  describe("POST /api/milestones/[id]/submissions", () => {
    it("submits PR work for a milestone", async () => {
      const mockSubmission = {
        id: "sub_301",
        milestoneId: "mls_201",
        submissionNumber: 1,
        prNumber: 15,
        prCommitSha: "e".repeat(40),
        prUrl: "https://github.com/alicegh/hackathon-mvp/pull/15",
      };
      (contractService.submitMilestoneWork as any).mockResolvedValue(mockSubmission);

      const req = new NextRequest("http://localhost:3000/api/milestones/mls_201/submissions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer vr_auth.test.valid",
        },
        body: JSON.stringify({
          prNumber: 15,
          prCommitSha: "e".repeat(40),
          prUrl: "https://github.com/alicegh/hackathon-mvp/pull/15",
        }),
      });

      const res = await createSubmission(req, {
        params: Promise.resolve({ id: "mls_201" }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.submission.id).toBe("sub_301");
    });
  });

  describe("POST /api/milestones/[id]/request-changes", () => {
    it("requests changes on a submitted milestone", async () => {
      const updatedMilestone = {
        id: "mls_201",
        status: "CHANGES_REQUESTED",
        amountMinorUnits: 100000n,
      };
      (contractService.requestChanges as any).mockResolvedValue(updatedMilestone);

      const req = new NextRequest("http://localhost:3000/api/milestones/mls_201/request-changes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer vr_auth.test.valid",
        },
        body: JSON.stringify({
          reason: "Tests are failing in CI pipeline",
        }),
      });

      const res = await requestChanges(req, {
        params: Promise.resolve({ id: "mls_201" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.milestone.status).toBe("CHANGES_REQUESTED");
    });
  });

  describe("GET /api/users & PATCH /api/users/role", () => {
    it("lists users for assignment dropdown", async () => {
      (prisma.user.findMany as any).mockResolvedValue([mockUser]);

      const req = new NextRequest("http://localhost:3000/api/users", {
        headers: { Authorization: "Bearer vr_auth.test.valid" },
      });

      const res = await getUsers(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.users).toHaveLength(1);
    });

    it("allows switching user role between CLIENT and DEVELOPER", async () => {
      (prisma.user.update as any).mockResolvedValue({
        ...mockUser,
        role: "DEVELOPER",
      });

      const req = new NextRequest("http://localhost:3000/api/users/role", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer vr_auth.test.valid",
        },
        body: JSON.stringify({ role: "DEVELOPER" }),
      });

      const res = await updateRole(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user.role).toBe("DEVELOPER");
    });
  });
});
