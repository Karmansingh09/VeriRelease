/**
 * VeriRelease OpenAI AI Evaluation Provider
 *
 * Connects to OpenAI API using structured JSON output to evaluate
 * pull request evidence against acceptance criteria.
 */

import type { AiEvaluationProvider } from "../ai-provider.interface";
import type {
  AiEvaluationRequest,
  AiEvaluationResult,
  AiCriterionResult,
} from "../types";
import { DemoAiProvider } from "./demo-ai-provider";

export interface OpenAiProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAiAiProvider implements AiEvaluationProvider {
  readonly name = "openai";
  readonly isDemo = false;
  private readonly demoFallback = new DemoAiProvider();

  constructor(private readonly config: OpenAiProviderConfig) {}

  async evaluate(request: AiEvaluationRequest): Promise<AiEvaluationResult> {
    const apiKey = this.config.apiKey;
    const model = this.config.model ?? "gpt-4o-2024-08-06";

    // If key is empty or obvious placeholder, cleanly fallback to DemoAiProvider
    if (!apiKey || apiKey.startsWith("sk-mock") || apiKey.includes("placeholder")) {
      return this.demoFallback.evaluate(request);
    }

    const systemPrompt = `You are VeriRelease AI Evaluation Engine, an impartial code verification auditor.
Your job is to rigorously evaluate GitHub pull request evidence against frozen milestone acceptance criteria.
You do NOT authorize payments or transfer funds.
You produce structured assessments of whether each criterion is met based STRICTLY on provided evidence.
If evidence is missing or insufficient for a criterion, mark it as NOT passed.
Never assume checks passed if no check results are provided.`;

    const userPrompt = JSON.stringify({
      contract: request.contract,
      milestone: request.milestone,
      submission: request.submission,
      criteria: request.criteria,
      evidence: request.evidence,
    });

    try {
      const response = await fetch(
        (this.config.baseUrl ?? "https://api.openai.com/v1") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `Evaluate the following milestone deliverables and evidence against criteria. Return a JSON object with:
{
  "overallAssessment": string,
  "criterionAssessments": [
    {
      "criterionId": string,
      "passed": boolean,
      "confidence": number between 0 and 1,
      "reason": string,
      "supportingEvidence": object
    }
  ],
  "missingEvidence": string[],
  "risks": string[],
  "suggestedAction": "APPROVE_PAYOUT_ELIGIBILITY" | "REQUEST_CHANGES" | "MANUAL_REVIEW"
}

Payload:
${userPrompt}`,
              },
            ],
            temperature: 0.1,
          }),
        }
      );

      if (!response.ok) {
        // Fallback to demo provider if API returns error
        return this.demoFallback.evaluate(request);
      }

      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        return this.demoFallback.evaluate(request);
      }

      const parsed = JSON.parse(content) as {
        overallAssessment?: string;
        criterionAssessments?: Array<{ criterionId?: string; passed?: boolean; confidence?: number; reason?: string; supportingEvidence?: Record<string, unknown> }>;
        missingEvidence?: string[];
        risks?: string[];
        suggestedAction?: "APPROVE_PAYOUT_ELIGIBILITY" | "REQUEST_CHANGES" | "MANUAL_REVIEW";
      };

      // Re-map criterionAssessments to match criteria titles and types
      const criterionAssessments: AiCriterionResult[] = request.criteria.map((c) => {
        const found = parsed.criterionAssessments?.find(
          (a) => a.criterionId === c.criterionId
        );
        return {
          criterionId: c.criterionId,
          criterionTitle: c.title,
          criterionType: c.criterionType,
          isMandatory: c.isMandatory,
          passed: Boolean(found?.passed),
          confidence: typeof found?.confidence === "number" ? found.confidence : 0.8,
          reason: found?.reason ?? "Evaluated by AI",
          supportingEvidence: found?.supportingEvidence ?? {},
        };
      });

      return {
        overallAssessment: parsed.overallAssessment ?? "AI assessment completed",
        criterionAssessments,
        missingEvidence: Array.isArray(parsed.missingEvidence) ? parsed.missingEvidence : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        suggestedAction: parsed.suggestedAction ?? "MANUAL_REVIEW",
        provider: "openai",
        model,
        isDemoMode: false,
        evaluatedAt: new Date(),
      };
    } catch {
      // In case of network errors or sandbox isolation, fallback gracefully
      return this.demoFallback.evaluate(request);
    }
  }
}
