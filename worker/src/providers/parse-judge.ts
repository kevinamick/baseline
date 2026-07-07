// Shared judge-response parsing (#204): every provider's judge() returns the same JSON-or-bust
// shape, so the parse lives here once rather than copied into each client. A model that doesn't
// emit the {score, reasoning} object scores 0 with the raw text as reasoning — the call still
// cost tokens, so usage is reported either way (the run is metered on attempts, not successes).
//
// #436: a judge completion that hits the token cap mid-JSON used to flatten straight to score 0,
// discarding a score the model had already committed to. The judge prompt puts `score` first, so
// a truncated response almost always contains a complete leading `"score": <n>` field even when
// `reasoning` (or the closing brace) never arrived — salvage it instead of throwing the whole
// verdict away. This is the ONE seam every provider funnels through, so the salvage + logging
// live here once, not per-provider.

import type { LLMJudgeResult, TokenUsage } from "./llm.js";
import { log } from "../log.js";

// The judge default max_tokens, shared by every provider's judge() call so raising it never
// needs a per-provider edit (#436). 1024 (the old Anthropic-only default) was tight for a verbose
// judgment against a multi-step criterion and truncated routinely; the fetch providers already
// ran judge calls at 4096 for reasoning-model headroom (see fetch-provider.ts). Pinning Anthropic
// to the same value removes the drift and gives every provider the same truncation margin.
export const JUDGE_MAX_TOKENS = 4096;

// Bounded snippet for parse-failure warn logs — never the full response body (#38: no raw
// bodies, no key material). 500 matches the existing raw-text fallback below.
const LOG_SNIPPET_LENGTH = 500;

// Require a trailing delimiter (whitespace, comma, or closing brace) after the digits so we only
// salvage a score whose number token is actually complete. A response cut mid-digit (e.g. text
// ending in `"score": 0.9` with nothing after it) can't be told apart from one that would have
// continued with more digits, so that case intentionally does NOT match and falls through to the
// existing 0-score fallback.
const SCORE_FIELD_RE = /"score"\s*:\s*(-?\d+(?:\.\d+)?)(?=[\s,}])/;
// The reasoning field's opening quote plus whatever text follows, truncated or not; captured
// greedily since a genuinely truncated response never reaches its closing quote.
const REASONING_FIELD_RE = /"reasoning"\s*:\s*"((?:\\.|[^"\\])*)/;

function clampScore(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export function parseJudgeResponse(text: string, usage: TokenUsage): LLMJudgeResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");
    const parsed = JSON.parse(jsonMatch[0]) as { score: unknown; reasoning: unknown };
    const score = clampScore(Number(parsed.score));
    const reasoning = String(parsed.reasoning ?? "");
    return { score, reasoning, usage };
  } catch {
    const snippet = text.slice(0, LOG_SNIPPET_LENGTH);
    const scoreMatch = text.match(SCORE_FIELD_RE);

    if (scoreMatch) {
      const score = clampScore(Number(scoreMatch[1]));
      const reasoningMatch = text.match(REASONING_FIELD_RE);
      const partial = reasoningMatch ? reasoningMatch[1].trim() : "";
      const reasoning = partial
        ? `[Judge response truncated; score salvaged] ${partial}`
        : "[Judge response truncated; score salvaged, no reasoning text recovered]";
      log.warn("Judge response failed full JSON parse; salvaged score from partial response", {
        event: "judge_response.parse_failed",
        salvaged: true,
        score,
        snippet,
      });
      return { score, reasoning, usage };
    }

    log.warn("Judge response failed full JSON parse; no score recoverable, scoring 0", {
      event: "judge_response.parse_failed",
      salvaged: false,
      snippet,
    });
    return { score: 0, reasoning: `Parse error. Raw: ${snippet}`, usage };
  }
}
