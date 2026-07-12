import { describe, it, expect } from "vitest";
import { computeModelDiff, hasNewModels, type ProviderLiveResult } from "./diff.ts";
import type { IgnoreEntry } from "./ignore-list.ts";

const REGISTRY = {
  "claude-haiku-4-5-20251001": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-opus-4-8": "anthropic",
  "gpt-5": "openai",
  "gpt-5-mini": "openai",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
  "mistral-large-latest": "mistral",
  "mistral-small-latest": "mistral",
} as const;

describe("computeModelDiff", () => {
  it("reports a genuinely new model as added", () => {
    const results: ProviderLiveResult[] = [
      {
        provider: "anthropic",
        liveIds: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8", "claude-opus-5"],
      },
    ];
    const diff = computeModelDiff(results, REGISTRY, []);
    expect(diff.added.anthropic).toEqual(["claude-opus-5"]);
    expect(diff.disappeared.anthropic).toEqual([]);
    expect(diff.skipped).toEqual([]);
  });

  it("excludes ignore-listed ids from added, reporting them separately", () => {
    const results: ProviderLiveResult[] = [
      {
        provider: "anthropic",
        liveIds: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8", "claude-1"],
      },
    ];
    const ignore: IgnoreEntry[] = [{ provider: "anthropic", id: "claude-1", reason: "ancient" }];
    const diff = computeModelDiff(results, REGISTRY, ignore);
    expect(diff.added.anthropic).toEqual([]);
    expect(diff.ignoredNew.anthropic).toEqual(["claude-1"]);
  });

  it("reports a registry model missing from the live list as disappeared", () => {
    const results: ProviderLiveResult[] = [
      {
        provider: "anthropic",
        liveIds: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"], // opus missing
      },
    ];
    const diff = computeModelDiff(results, REGISTRY, []);
    expect(diff.disappeared.anthropic).toEqual(["claude-opus-4-8"]);
    expect(diff.added.anthropic).toEqual([]);
  });

  it("records a provider with no key as skipped, contributing nothing to added/disappeared", () => {
    const results: ProviderLiveResult[] = [
      { provider: "openai", liveIds: null, warning: "OPENAI_API_KEY not set" },
    ];
    const diff = computeModelDiff(results, REGISTRY, []);
    expect(diff.skipped).toEqual(["openai"]);
    expect(diff.added.openai).toEqual([]);
    expect(diff.disappeared.openai).toEqual([]);
  });

  it("does not let one provider's ignore entries suppress another provider's identical id", () => {
    const results: ProviderLiveResult[] = [
      { provider: "anthropic", liveIds: [...Object.keys(REGISTRY).filter((k) => REGISTRY[k as keyof typeof REGISTRY] === "anthropic"), "shared-id"] },
      { provider: "openai", liveIds: [...Object.keys(REGISTRY).filter((k) => REGISTRY[k as keyof typeof REGISTRY] === "openai"), "shared-id"] },
    ];
    const ignore: IgnoreEntry[] = [{ provider: "anthropic", id: "shared-id" }];
    const diff = computeModelDiff(results, REGISTRY, ignore);
    expect(diff.ignoredNew.anthropic).toEqual(["shared-id"]);
    expect(diff.added.openai).toEqual(["shared-id"]);
  });
});

describe("hasNewModels", () => {
  const anthropicIds = Object.keys(REGISTRY).filter(
    (id) => REGISTRY[id as keyof typeof REGISTRY] === "anthropic"
  );

  it("is false when nothing was added across any provider", () => {
    const diff = computeModelDiff([{ provider: "anthropic", liveIds: anthropicIds }], REGISTRY, []);
    expect(hasNewModels(diff)).toBe(false);
  });

  it("is true when at least one provider has an added model", () => {
    const diff = computeModelDiff(
      [{ provider: "anthropic", liveIds: [...anthropicIds, "claude-new"] }],
      REGISTRY,
      []
    );
    expect(hasNewModels(diff)).toBe(true);
  });
});
