import { describe, it, expect } from "vitest";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import { MODEL_PRICES } from "@/lib/llm/model-prices";
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
    expect(estimateManagedSpendUsd("builder", "openai", "gpt-5", 5, 3)).toBeNull();
  });

  it("returns null when there are no judge calls", () => {
    expect(estimateManagedSpendUsd("builder", "anthropic", HAIKU, 0, 3)).toBeNull();
  });
});
