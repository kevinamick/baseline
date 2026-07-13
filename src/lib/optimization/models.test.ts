import { describe, it, expect } from "vitest";
import {
  REFLECT_MODELS,
  TARGET_MODELS,
  providerForReflectModel,
  reflectModelGroups,
  defaultReflectModelFor,
  PROVIDER_DEFAULT_REFLECT_MODEL,
  PROVIDER_DEFAULT_SIMPLE_MODEL,
  PROVIDER_DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_SIMPLE_REFLECT_MODEL,
} from "./models";
import { providerForModel } from "@/lib/llm/model-prices";
import type { LlmProvider } from "@/lib/llm/providers";

// REFLECT_MODELS/TARGET_MODELS derive their provider facts straight from the shared registry
// (worker/src/providers/registry.ts, #379) via src/lib/llm/model-prices.ts — there is nothing left
// to keep in lockstep with a separate parity test, so these are ordinary unit tests of this
// module's UI-presentation layer (labels, grouping, defaulting) over that shared registry.
describe("reflect-model registry (#204)", () => {
  it("covers all four providers now that OpenAI, Google, and Mistral are runtime-ready", () => {
    const providers = new Set(REFLECT_MODELS.map((m) => providerForReflectModel(m.id)));
    expect(providers).toEqual(new Set<LlmProvider>(["anthropic", "openai", "google", "mistral"]));
  });

  it("providerForReflectModel resolves via the shared registry's providerForModel", () => {
    for (const m of REFLECT_MODELS) {
      expect(providerForReflectModel(m.id)).toBe(providerForModel(m.id));
    }
  });

  it("ships the Anthropic defaults as the global defaults", () => {
    expect(DEFAULT_REFLECT_MODEL).toBe(PROVIDER_DEFAULT_REFLECT_MODEL.anthropic);
    expect(DEFAULT_SIMPLE_REFLECT_MODEL).toBe(PROVIDER_DEFAULT_SIMPLE_MODEL.anthropic);
  });

  it("judge model constant matches the Simple default (both are the fast per-provider model)", () => {
    for (const p of ["anthropic", "openai", "google", "mistral"] as const) {
      expect(PROVIDER_DEFAULT_JUDGE_MODEL[p]).toBe(PROVIDER_DEFAULT_SIMPLE_MODEL[p]);
    }
  });

  it("keeps Managed Agent target models Anthropic-only for now (#204)", () => {
    for (const m of TARGET_MODELS) expect(providerForModel(m.id)).toBe("anthropic");
  });
});

describe("reflectModelGroups + defaultReflectModelFor (#204)", () => {
  it("only groups providers the Team can use, in LLM_PROVIDERS order", () => {
    const groups = reflectModelGroups(["google", "anthropic"]);
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "google"]);
    expect(groups.every((g) => g.models.length > 0)).toBe(true);
  });

  it("omits providers the Team can't use", () => {
    const groups = reflectModelGroups(["openai"]);
    expect(groups.map((g) => g.provider)).toEqual(["openai"]);
    expect(groups[0].models.every((m) => providerForModel(m.id) === "openai")).toBe(true);
  });

  it("keeps the preferred model when its provider is usable", () => {
    expect(
      defaultReflectModelFor(["anthropic", "openai"], DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL),
    ).toBe(DEFAULT_REFLECT_MODEL);
  });

  it("falls back to the first usable provider's default when the preferred isn't usable", () => {
    expect(
      defaultReflectModelFor(["openai"], DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL),
    ).toBe(PROVIDER_DEFAULT_REFLECT_MODEL.openai);
  });

  it("returns null when no provider is usable", () => {
    expect(defaultReflectModelFor([], DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL)).toBeNull();
  });
});

describe("reflectModelGroups live models (#485)", () => {
  it("appends live-listed models after the curated entries, flagged live with a raw-id label", () => {
    const groups = reflectModelGroups(["openai"], { openai: ["gpt-5.3-preview"] });
    const models = groups[0].models;
    const curatedCount = REFLECT_MODELS.filter((m) => providerForReflectModel(m.id) === "openai").length;
    expect(models).toHaveLength(curatedCount + 1);
    expect(models[models.length - 1]).toEqual({
      id: "gpt-5.3-preview",
      label: "gpt-5.3-preview",
      live: true,
    });
    // Curated entries keep their hand-written labels and carry no live flag.
    expect(models.slice(0, curatedCount).every((m) => !m.live)).toBe(true);
  });

  it("dedupes a live id that's already curated", () => {
    const groups = reflectModelGroups(["openai"], { openai: ["gpt-5", "gpt-5.3-preview"] });
    const ids = groups[0].models.map((m) => m.id);
    expect(ids.filter((id) => id === "gpt-5")).toHaveLength(1);
    expect(ids).toContain("gpt-5.3-preview");
  });

  it("leaves providers without a live entry curated-only (managed mode)", () => {
    const groups = reflectModelGroups(["anthropic", "openai"], { openai: ["gpt-5.3-preview"] });
    const anthropicGroup = groups.find((g) => g.provider === "anthropic")!;
    expect(anthropicGroup.models.every((m) => !m.live)).toBe(true);
  });

  it("renders exactly the pre-#485 grouping when no live map is passed", () => {
    expect(reflectModelGroups(["openai"])).toEqual(reflectModelGroups(["openai"], {}));
  });
});
