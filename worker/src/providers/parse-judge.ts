// Shared judge-response parsing (#204): every provider's judge() returns the same JSON-or-bust
// shape, so the parse lives here once rather than copied into each client. A model that doesn't
// emit the {score, reasoning} object scores 0 with the raw text as reasoning — the call still
// cost tokens, so usage is reported either way (the run is metered on attempts, not successes).

import type { LLMJudgeResult, TokenUsage } from "./llm.js";

export function parseJudgeResponse(text: string, usage: TokenUsage): LLMJudgeResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");
    const parsed = JSON.parse(jsonMatch[0]) as { score: unknown; reasoning: unknown };
    const score = Math.max(0, Math.min(1, Number(parsed.score)));
    const reasoning = String(parsed.reasoning ?? "");
    return { score, reasoning, usage };
  } catch {
    return { score: 0, reasoning: `Parse error. Raw: ${text.slice(0, 500)}`, usage };
  }
}
