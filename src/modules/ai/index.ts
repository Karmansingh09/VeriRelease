/**
 * VeriRelease AI Evaluation Module
 *
 * Provides AI assessment of GitHub evidence, bounded by the deterministic policy engine.
 */

export * from "./types";
export * from "./ai-provider.interface";
export * from "./providers/demo-ai-provider";
export * from "./providers/openai-ai-provider";
export * from "./ai-evaluation-service";

import { env } from "../../lib/env";
import { prisma } from "../../lib/prisma";
import { DefaultAuditService, PrismaAuditRepository } from "../audit";
import { PolicyEvaluationService } from "../policy/policy-evaluation-service";
import { GitHubEvidenceService } from "../github/evidence/github-evidence-service";
import { FetchGitHubProvider } from "../github/provider/fetch-github-provider";
import { PrismaEvidenceRepository } from "../github/evidence/prisma-evidence-repository";
import { OpenAiAiProvider } from "./providers/openai-ai-provider";
import { DemoAiProvider } from "./providers/demo-ai-provider";
import { AiEvaluationService } from "./ai-evaluation-service";

function createAiProvider() {
  if (env.OPENAI_API_KEY && !env.OPENAI_API_KEY.startsWith("sk-mock") && !env.OPENAI_API_KEY.includes("placeholder")) {
    return new OpenAiAiProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    });
  }
  return new DemoAiProvider();
}

const auditService = new DefaultAuditService(new PrismaAuditRepository(prisma), prisma);
const policyService = new PolicyEvaluationService(
  undefined,
  undefined,
  undefined,
  auditService,
  prisma
);

const githubProvider = new FetchGitHubProvider({
  baseUrl: env.GITHUB_API_BASE_URL,
  accessToken: env.GITHUB_ACCESS_TOKEN,
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
});

const evidenceService = new GitHubEvidenceService(
  githubProvider,
  new PrismaEvidenceRepository(prisma),
  auditService,
  prisma
);

export const aiEvaluationService = new AiEvaluationService(
  createAiProvider(),
  policyService,
  evidenceService,
  auditService,
  prisma
);
