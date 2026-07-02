import { describe, it, expect } from "vitest";
import { parseJudgeResponse } from "./parse-judge.js";

// parseJudgeResponse (#204): shared judge-response parsing used by every provider's judge().
// Direct unit tests here (the provider tests only exercise it indirectly through a couple of
// shapes) so every branch — parse failure, non-finite score, out-of-range clamping — is covered
// once rather than relying on incidental coverage from each provider's fixtures.

const USAGE = { inputTokens: 10, outputTokens: 5, model: "test-model" };

describe("parseJudgeResponse", () => {
  it("parses a well-formed {score, reasoning} object", () => {
    const res = parseJudgeResponse('{"score": 0.75, "reasoning": "solid"}', USAGE);
    expect(res).toEqual({ score: 0.75, reasoning: "solid", usage: USAGE });
  });

  it("extracts the JSON object even when surrounded by extra text", () => {
    const res = parseJudgeResponse('Here is my verdict: {"score": 1, "reasoning": "great"} thanks', USAGE);
    expect(res.score).toBe(1);
    expect(res.reasoning).toBe("great");
  });

  it("falls back to score 0 with a parse-error reasoning when there is no JSON object", () => {
    const res = parseJudgeResponse("not json at all", USAGE);
    expect(res.score).toBe(0);
    expect(res.reasoning).toMatch(/^Parse error\. Raw: not json at all$/);
    expect(res.usage).toBe(USAGE);
  });

  it("falls back to score 0 when the JSON is malformed", () => {
    const res = parseJudgeResponse('{"score": 0.5, "reasoning": "unterminated', USAGE);
    expect(res.score).toBe(0);
    expect(res.reasoning).toMatch(/^Parse error/);
  });

  it("scores 0 when score is non-numeric (not finite)", () => {
    const res = parseJudgeResponse('{"score": "not-a-number", "reasoning": "why"}', USAGE);
    expect(res.score).toBe(0);
    expect(res.reasoning).toBe("why");
  });

  it("scores 0 when score is missing entirely", () => {
    const res = parseJudgeResponse('{"reasoning": "no score field"}', USAGE);
    expect(res.score).toBe(0);
    expect(res.reasoning).toBe("no score field");
  });

  it("clamps a score above 1 down to 1", () => {
    const res = parseJudgeResponse('{"score": 5, "reasoning": "overshoot"}', USAGE);
    expect(res.score).toBe(1);
  });

  it("clamps a negative score up to 0", () => {
    const res = parseJudgeResponse('{"score": -3, "reasoning": "undershoot"}', USAGE);
    expect(res.score).toBe(0);
  });

  it("defaults reasoning to an empty string when absent", () => {
    const res = parseJudgeResponse('{"score": 0.4}', USAGE);
    expect(res.reasoning).toBe("");
  });

  it("truncates the raw text in the parse-error reasoning to 500 chars", () => {
    const longText = "x".repeat(600);
    const res = parseJudgeResponse(longText, USAGE);
    expect(res.reasoning).toBe(`Parse error. Raw: ${"x".repeat(500)}`);
  });
});
