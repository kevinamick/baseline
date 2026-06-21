import { describe, it, expect } from "vitest";
import { LLM_PROVIDERS, MANAGED_KEY_ENV, isLlmProvider } from "./provider-list.js";

// The canonical provider set. The app's src/lib/llm/providers.ts pins the SAME
// literal in its own test — the two arrays must stay identical (the worker is a
// separate project pending the shared-package extraction, #93). Changing the set
// means changing both files AND both pins, which is the intended friction.
const CANONICAL = ["anthropic", "openai", "google"];

describe("worker LLM provider list (#184)", () => {
  it("matches the canonical provider set (parity with the app)", () => {
    expect([...LLM_PROVIDERS]).toEqual(CANONICAL);
  });

  it("has a managed-key env var for every provider", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(MANAGED_KEY_ENV[provider]).toBeTruthy();
    }
    expect(Object.keys(MANAGED_KEY_ENV).sort()).toEqual([...LLM_PROVIDERS].sort());
  });

  it("validates membership", () => {
    expect(isLlmProvider("anthropic")).toBe(true);
    expect(isLlmProvider("bogus")).toBe(false);
    expect(isLlmProvider(123)).toBe(false);
  });
});
