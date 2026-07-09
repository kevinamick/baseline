import { describe, it, expect } from "vitest";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import { ESTIMATE_JUDGE_MODEL, MODEL_PRICES } from "@/lib/llm/model-prices";
import { PLANS } from "@/lib/billing/plans";

const HAIKU = "claude-haiku-4-5-20251001";

describe("estimateManagedSpendUsd (#185)", () => {
  it("computes calls × per-call cost × (1 + markup)", () => {
    const price = MODEL_PRICES.anthropic[HAIKU];
    const rows = 5;
    const criteria = 3;
    const perCall =
      price.typicalInputTokens * price.inputUsdPerToken +
      price.typicalOutputTokens * price.outputUsdPerToken;
    const expected =
      rows * criteria * perCall * (1 + PLANS.builder.managedMarkupPct! / 100);

    expect(estimateManagedSpendUsd("builder", "anthropic", HAIKU, rows, criteria)).toBeCloseTo(
      expected,
      10,
    );
  });

  it("scales with the plan markup (Scale < Builder for the same usage)", () => {
    const builder = estimateManagedSpendUsd("builder", "anthropic", HAIKU, 10, 2)!;
    const scale = estimateManagedSpendUsd("scale", "anthropic", HAIKU, 10, 2)!;
    expect(scale).toBeLessThan(builder); // 30% markup < 40% markup
  });

  it("returns null for a Free/BYO-only plan (no managed estimate)", () => {
    expect(estimateManagedSpendUsd("free", "anthropic", HAIKU, 5, 3)).toBeNull();
  });

  it("returns null for an unpriced model", () => {
    expect(estimateManagedSpendUsd("builder", "anthropic", "claude-bogus", 5, 3)).toBeNull();
    // OpenAI/Google are priced now (#204); an unknown model on any provider still returns null.
    expect(estimateManagedSpendUsd("builder", "openai", "gpt-bogus", 5, 3)).toBeNull();
  });

  it("prices OpenAI and Google models now that they're runtime-ready (#204)", () => {
    expect(estimateManagedSpendUsd("builder", "openai", "gpt-5", 5, 3)).toBeGreaterThan(0);
    expect(estimateManagedSpendUsd("builder", "google", "gemini-2.5-pro", 5, 3)).toBeGreaterThan(0);
  });

  it("returns null when there are no judge calls", () => {
    expect(estimateManagedSpendUsd("builder", "anthropic", HAIKU, 0, 3)).toBeNull();
  });
});

// Regression pin for the opt-4afa3642 prod incident (2026-07-08): the
// optimization reserve priced the judge term at budget × instanceCount when
// budget_rollouts is already denominated in instance-invocations, reserving
// $13.52 for a run whose true worst case was ~$0.59. The action must pass the
// budget alone as the judge volume; at the incident's numbers that keeps the
// whole reserve far below the wrong figure.
describe("optimization reserve units (incident opt-4afa3642)", () => {
  it("a budget-10, 7-criteria run reserves well under a dollar for judging", () => {
    const judge = estimateManagedSpendUsd(
      "builder",
      "anthropic",
      ESTIMATE_JUDGE_MODEL,
      10, // budget_rollouts — instance-invocations, never ×instanceCount(45)
      7,
    );
    expect(judge).not.toBeNull();
    expect(judge!).toBeLessThan(1);
    // The buggy volume (10 × 45 instances) priced this same term at ~$13.23.
    const buggy = estimateManagedSpendUsd("builder", "anthropic", ESTIMATE_JUDGE_MODEL, 10 * 45, 7);
    expect(buggy!).toBeGreaterThan(13);
  });
});
