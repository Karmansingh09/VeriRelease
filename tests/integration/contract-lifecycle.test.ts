/**
 * Contract & Milestone Lifecycle PostgreSQL Integration Test Suite
 *
 * Runs against the live PostgreSQL 18 test database on port 5433:
 * - Contract creation with DB constraints
 * - Milestone creation with multi-criteria versioning
 * - Milestone funding transition and contract activation
 * - PR submission with row locks, immutable criteria snapshots, and RFC 8785 hash
 * - Changes requested transition
 * - Work resubmission with sequential submission numbering
 * - Append-only transactional audit logging verification
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, PoolClient } from "pg";
import { prisma } from "../../src/lib/prisma";
import { contractService } from "../../src/modules/contracts";
import {
  DomainForbiddenError,
  DomainConflictError,
  DomainValidationError,
} from "../../src/modules/common/errors";

const pool = new Pool({
  host: process.env.PGHOST || "/tmp",
  port: parseInt(process.env.PGPORT || "5433", 10),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "verirelease_test",
});

describe("Contract & Milestone Lifecycle Integration Tests (PostgreSQL)", () => {
  let pgClient: PoolClient;

  const clientUserId = "usr_client_integ_1";
  const devUserId = "usr_dev_integ_1";

  beforeAll(async () => {
    pgClient = await pool.connect();
  });

  afterAll(async () => {
    if (pgClient) pgClient.release();
    await pool.end();
  });

  beforeEach(async () => {
    await pgClient.query(`
      SET ROLE postgres;
      TRUNCATE TABLE 
        "OAuthTransaction",
        "GitHubEvidenceSnapshot",
        "GitHubWebhookDelivery",
        "GitHubRepository",
        "PaymentReconciliation",
        "AuditLog", 
        "PaymentTransaction", 
        "PolicyEvaluation", 
        "MilestoneSubmission", 
        "AcceptanceCriterion", 
        "Milestone", 
        "Contract", 
        "User" 
      CASCADE;
    `);

    // Seed test users
    await prisma.user.createMany({
      data: [
        {
          id: clientUserId,
          email: "client.integ@example.com",
          name: "Client Integ",
          role: "CLIENT",
          isActive: true,
        },
        {
          id: devUserId,
          email: "dev.integ@example.com",
          name: "Dev Integ",
          role: "DEVELOPER",
          githubUsername: "devinteg",
          isActive: true,
        },
      ],
    });
  });

  it("completes full contract and milestone lifecycle with audit trail in PostgreSQL", async () => {
    // 1. Client creates contract
    const contract = await contractService.createContract(clientUserId, {
      title: "Full-Stack Payment System",
      description: "Build PayPal AI verified milestones",
      developerId: devUserId,
      totalAmountUsd: 5000,
      currency: "USD",
      githubRepoOwner: "clientorg",
      githubRepoName: "payment-system",
    });

    expect(contract.id).toBeDefined();
    expect(contract.status).toBe("DRAFT");
    expect(contract.totalAmountMinorUnits).toBe(500000n);

    // 2. Client adds a milestone with acceptance criteria
    const milestone = await contractService.addMilestone(contract.id, clientUserId, {
      title: "Milestone 1: Webhook Security",
      description: "Implement HMAC verification and signature checks",
      amountUsd: 2000,
      criteria: [
        {
          title: "HMAC Verification",
          description: "Verify sha256 webhook signatures",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
        {
          title: "Payload Redaction",
          description: "Redact secrets from logs",
          criterionType: "AUTOMATED_TEST",
          isMandatory: true,
        },
      ],
    });

    expect(milestone.id).toBeDefined();
    expect(milestone.status).toBe("DRAFT");
    expect(milestone.criteria).toHaveLength(2);

    // 3. Client funds the milestone (DRAFT -> FUNDED)
    const fundedMilestone = await contractService.fundMilestone(milestone.id, clientUserId);
    expect(fundedMilestone.status).toBe("FUNDED");
    expect(fundedMilestone.fundedAt).not.toBeNull();

    // Verify contract auto-activated
    const updatedContract = await prisma.contract.findUnique({ where: { id: contract.id } });
    expect(updatedContract?.status).toBe("ACTIVE");

    // 4. Developer submits PR work (FUNDED -> SUBMITTED)
    const submission1 = await contractService.submitMilestoneWork(milestone.id, devUserId, {
      prNumber: 10,
      prCommitSha: "1111111111111111111111111111111111111111",
      prUrl: "https://github.com/clientorg/payment-system/pull/10",
    });

    expect(submission1.submissionNumber).toBe(1);
    expect(submission1.criteriaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(submission1.criteriaSnapshot).toHaveLength(2);

    // Verify milestone updated to SUBMITTED
    const submittedMilestone = await prisma.milestone.findUnique({ where: { id: milestone.id } });
    expect(submittedMilestone?.status).toBe("SUBMITTED");

    // 5. Client requests changes (SUBMITTED -> CHANGES_REQUESTED)
    const changesMilestone = await contractService.requestChanges(
      milestone.id,
      clientUserId,
      "Please add test coverage for empty signatures"
    );
    expect(changesMilestone.status).toBe("CHANGES_REQUESTED");

    // 6. Developer resubmits with updated commit (CHANGES_REQUESTED -> SUBMITTED)
    const submission2 = await contractService.submitMilestoneWork(milestone.id, devUserId, {
      prNumber: 10,
      prCommitSha: "2222222222222222222222222222222222222222",
      prUrl: "https://github.com/clientorg/payment-system/pull/10",
    });

    expect(submission2.submissionNumber).toBe(2);
    expect(submission2.prCommitSha).toBe("2222222222222222222222222222222222222222");

    // 7. Verify audit trail in PostgreSQL
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entityId: contract.id },
          { entityId: milestone.id },
          { entityId: submission1.id },
          { entityId: submission2.id },
        ],
      },
      orderBy: { timestamp: "asc" },
    });

    const actions = auditLogs.map((l) => l.action);
    expect(actions).toContain("CONTRACT_CREATED");
    expect(actions).toContain("MILESTONE_CREATED");
    expect(actions).toContain("MILESTONE_FUNDED");
    expect(actions).toContain("MILESTONE_SUBMITTED");
    expect(actions).toContain("CHANGES_REQUESTED");
    expect(actions).toContain("MILESTONE_RESUBMITTED");

    // 8. Verify detailed view
    const details = await contractService.getMilestoneDetails(milestone.id, clientUserId);
    expect(details.submissions).toHaveLength(2);
    expect(details.criteria).toHaveLength(2);
    expect(details.auditTimeline.length).toBeGreaterThan(0);
  });

  it("enforces role boundaries: developers cannot fund; clients cannot submit", async () => {
    const contract = await contractService.createContract(clientUserId, {
      title: "Boundary Test Contract",
      description: "Testing permissions",
      developerId: devUserId,
      githubRepoOwner: "clientorg",
      githubRepoName: "perm-test",
    });

    const milestone = await contractService.addMilestone(contract.id, clientUserId, {
      title: "Perm Milestone",
      description: "Check permissions",
      criteria: [
        {
          title: "Criterion A",
          description: "Desc A",
          criterionType: "AUTOMATED_TEST",
        },
      ],
    });

    // Developer attempts to fund -> 403 Forbidden
    await expect(
      contractService.fundMilestone(milestone.id, devUserId)
    ).rejects.toThrow(DomainForbiddenError);

    // Fund properly as client
    await contractService.fundMilestone(milestone.id, clientUserId);

    // Client attempts to submit work -> 403 Forbidden
    await expect(
      contractService.submitMilestoneWork(milestone.id, clientUserId, {
        prNumber: 1,
        prCommitSha: "3333333333333333333333333333333333333333",
        prUrl: "https://github.com/clientorg/perm-test/pull/1",
      })
    ).rejects.toThrow(DomainForbiddenError);
  });
});
