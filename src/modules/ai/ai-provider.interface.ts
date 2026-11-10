/**
 * AI Provider Interface
 */

import type { AiEvaluationRequest, AiEvaluationResult } from "./types";

export interface AiEvaluationProvider {
  readonly name: string;
  readonly isDemo: boolean;
  evaluate(request: AiEvaluationRequest): Promise<AiEvaluationResult>;
}
