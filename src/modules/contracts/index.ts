export * from "./types";
export * from "./milestone-state-machine";
export * from "./contract-repository.interface";
export * from "./milestone-repository.interface";
export * from "./submission-repository.interface";
export * from "./prisma-contract-repository";
export * from "./prisma-milestone-repository";
export * from "./prisma-submission-repository";
export * from "./contract-service";

import { prisma } from "../../lib/prisma";
import { DefaultAuditService, PrismaAuditRepository } from "../audit";
import { PrismaContractRepository } from "./prisma-contract-repository";
import { PrismaMilestoneRepository } from "./prisma-milestone-repository";
import { PrismaSubmissionRepository } from "./prisma-submission-repository";
import { ContractService } from "./contract-service";

export const contractService = new ContractService(
  new PrismaContractRepository(prisma),
  new PrismaMilestoneRepository(prisma),
  new PrismaSubmissionRepository(prisma),
  new DefaultAuditService(new PrismaAuditRepository(prisma)),
  prisma
);
