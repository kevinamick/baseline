import { describe, it, expect } from "vitest";
import { buildMarkdownReport, TRACKING_ISSUE_TITLE } from "./report.ts";
import { computeModelDiff } from "./diff.ts";
import type { ProviderLiveResult } from "./diff.ts";
import type { LiteLlmData } from "./litellm-prices.ts";

const REGISTRY = {
  "claude-sonnet-4-6": "anthropic",
  "gpt-5": "openai",
} as const;

describe("buildMarkdownReport", () => {
  it("carries the stable tracking-issue title marker", () => {
    const results: ProviderLiveResult[] = [{ provider: "anthropic", liveIds: ["claude-sonnet-4-6"] }];
    const diff = computeModelDiff(results, REGISTRY, []);
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData: null,
      generatedAt: new Date("2026-07-11T00:00:00Z"),
    });
    expect(report).toContain(TRACKING_ISSUE_TITLE);
  });

  it("says 'no new models' when nothing changed", () => {
    const results: ProviderLiveResult[] = [{ provider: "anthropic", liveIds: ["claude-sonnet-4-6"] }];
    const diff = computeModelDiff(results, REGISTRY, []);
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData: null,
      generatedAt: new Date(),
    });
    expect(report).toContain("No new chat-capable models detected");
  });

  it("includes a paste-ready snippet + checklist for a new model", () => {
    const results: ProviderLiveResult[] = [
      { provider: "anthropic", liveIds: ["claude-sonnet-4-6", "claude-opus-5"] },
    ];
    const diff = computeModelDiff(results, REGISTRY, []);
    const litellmData: LiteLlmData = {
      "claude-opus-5": {
        litellm_provider: "anthropic",
        input_cost_per_token: 0.00002,
        output_cost_per_token: 0.0001,
      },
    };
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData,
      generatedAt: new Date(),
    });
    expect(report).toContain("claude-opus-5");
    expect(report).toContain("verify price against the provider's pricing page");
    expect(report).toContain("decide whether judge/reflect defaults should change");
    expect(report).toContain("add to the ignore list");
    expect(report).toContain("UNVERIFIED");
  });

  it("notes a skipped provider (no key configured) without listing it as changed", () => {
    const results: ProviderLiveResult[] = [
      { provider: "openai", liveIds: null, warning: "OPENAI_API_KEY not set" },
    ];
    const diff = computeModelDiff(results, REGISTRY, []);
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData: null,
      generatedAt: new Date(),
    });
    expect(report).toContain("Skipped");
    expect(report).toContain("OPENAI_API_KEY not set");
  });

  it("reports a disappeared registry model as a possible deprecation, report-only", () => {
    const results: ProviderLiveResult[] = [{ provider: "openai", liveIds: [] }]; // gpt-5 vanished
    const diff = computeModelDiff(results, REGISTRY, []);
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData: null,
      generatedAt: new Date(),
    });
    expect(report).toContain("Possible deprecation");
    expect(report).toContain("gpt-5");
    expect(report).toContain("report-only");
  });

  it("lists ignored ids separately from added, without a checklist", () => {
    const results: ProviderLiveResult[] = [
      { provider: "anthropic", liveIds: ["claude-sonnet-4-6", "claude-1"] },
    ];
    const diff = computeModelDiff(results, REGISTRY, [{ provider: "anthropic", id: "claude-1" }]);
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData: null,
      generatedAt: new Date(),
    });
    expect(report).toContain("Ignored (already dismissed");
    expect(report).toContain("claude-1");
    expect(report).toContain("No new models.");
  });

  it("notes when the LiteLLM fetch failed, without failing the report", () => {
    const results: ProviderLiveResult[] = [{ provider: "anthropic", liveIds: ["claude-sonnet-4-6"] }];
    const diff = computeModelDiff(results, REGISTRY, []);
    const report = buildMarkdownReport({
      diff,
      results,
      litellmData: null,
      generatedAt: new Date(),
    });
    expect(report).toContain("could not be fetched");
  });
});
