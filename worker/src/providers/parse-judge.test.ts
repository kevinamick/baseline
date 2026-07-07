import { describe, it, expect, vi, beforeEach } from "vitest";

// parseJudgeResponse (#204): shared judge-response parsing used by every provider's judge().
// Direct unit tests here (the provider tests only exercise it indirectly through a couple of
// shapes) so every branch — parse failure, non-finite score, out-of-range clamping — is covered
// once rather than relying on incidental coverage from each provider's fixtures.
//
// #436: a judge completion truncated by the token cap mid-JSON used to flatten to score 0 even
// when a complete leading `"score"` field had already arrived. These tests pin the salvage path,
// its clamping, the mid-field-truncation fallback, and the structured warn every parse failure
// (salvaged or not) now emits.

const warn = vi.fn();
vi.mock("../log.js", () => ({ log: { warn: (...args: unknown[]) => warn(...args), error: vi.fn(), info: vi.fn() } }));

import { parseJudgeResponse, JUDGE_MAX_TOKENS } from "./parse-judge.js";

const USAGE = { inputTokens: 10, outputTokens: 5, model: "test-model" };

describe("parseJudgeResponse", () => {
  beforeEach(() => warn.mockReset());

  it("parses a well-formed {score, reasoning} object", () => {
    const res = parseJudgeResponse('{"score": 0.75, "reasoning": "solid"}', USAGE);
    expect(res).toEqual({ score: 0.75, reasoning: "solid", usage: USAGE });
    expect(warn).not.toHaveBeenCalled();
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

  describe("truncation salvage (#436)", () => {
    it("salvages a complete leading score field from a response truncated mid-reasoning", () => {
      // Mirrors the observed run: the closing brace and the rest of `reasoning` never arrived.
      const res = parseJudgeResponse(
        '{"score": 0.92, "reasoning": "The response demonstrates good revision discipline by',
        USAGE,
      );
      expect(res.score).toBe(0.92);
      expect(res.reasoning).toContain("truncated");
      expect(res.reasoning).toContain("The response demonstrates good revision discipline by");
      expect(res.usage).toBe(USAGE);
    });

    it("salvages a complete score even when the reasoning field never started", () => {
      const res = parseJudgeResponse('{"score": 0.6, "reas', USAGE);
      expect(res.score).toBe(0.6);
      expect(res.reasoning).toContain("truncated");
      expect(res.reasoning).not.toContain("undefined");
    });

    it("clamps a salvaged score above 1 down to 1", () => {
      const res = parseJudgeResponse('{"score": 3, "reasoning": "cut off mid', USAGE);
      expect(res.score).toBe(1);
    });

    it("clamps a salvaged negative score up to 0", () => {
      const res = parseJudgeResponse('{"score": -2, "reasoning": "cut off mid', USAGE);
      expect(res.score).toBe(0);
    });

    it("falls back to 0 when the score field itself is truncated mid-digit", () => {
      // No delimiter after the digits: we can't tell whether more digits (or a decimal
      // continuation) would have followed, so this must NOT be salvaged.
      const res = parseJudgeResponse('{"score": 0.9', USAGE);
      expect(res.score).toBe(0);
      expect(res.reasoning).toMatch(/^Parse error/);
    });

    it("falls back to 0 when the response cuts off before any score digits arrive", () => {
      const res = parseJudgeResponse('{"score": ', USAGE);
      expect(res.score).toBe(0);
      expect(res.reasoning).toMatch(/^Parse error/);
    });

    it("emits a structured warn with a bounded snippet on a salvaged parse failure", () => {
      const text = '{"score": 0.92, "reasoning": "The response demonstrates good revision discipline';
      parseJudgeResponse(text, USAGE);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, attrs] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toMatch(/parse/i);
      expect(attrs.event).toBe("judge_response.parse_failed");
      expect(attrs.salvaged).toBe(true);
      expect(attrs.score).toBe(0.92);
      expect(attrs.snippet).toBe(text);
      // Never the full body beyond the bounded snippet, and never key material.
      expect(String(attrs.snippet).length).toBeLessThanOrEqual(500);
    });

    it("emits a structured warn with salvaged: false and a bounded snippet on a full fallback", () => {
      const longText = "not json at all, ".repeat(50);
      parseJudgeResponse(longText, USAGE);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, attrs] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toMatch(/parse/i);
      expect(attrs.event).toBe("judge_response.parse_failed");
      expect(attrs.salvaged).toBe(false);
      expect(attrs.score).toBeUndefined();
      expect(String(attrs.snippet).length).toBeLessThanOrEqual(500);
    });

    it("does not warn when the response parses cleanly", () => {
      parseJudgeResponse('{"score": 0.5, "reasoning": "fine"}', USAGE);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("JUDGE_MAX_TOKENS (#436)", () => {
    it("is the single shared default every provider's judge() call uses", () => {
      expect(JUDGE_MAX_TOKENS).toBe(4096);
    });
  });
});
