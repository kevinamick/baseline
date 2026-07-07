import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  RUNTIME_READY_PROVIDERS,
  isLlmProvider,
  isRuntimeReady,
} from "@/lib/llm/providers";

// LLM_PROVIDERS/PROVIDER_LABELS/RUNTIME_READY_PROVIDERS come straight from the shared registry
// (worker/src/providers/registry.ts, #379) via this module's re-export — there's nothing left to
// keep in lockstep with a separate parity test (the old worker/src/providers/provider-list.ts
// mirror is gone). This is now an ordinary sanity check of the app's import path.
const CANONICAL = ["anthropic", "openai", "google", "mistral"];

describe("LLM_PROVIDERS (#184)", () => {
  it("ships the canonical provider set", () => {
    expect([...LLM_PROVIDERS]).toEqual(CANONICAL);
  });

  it("has a display label for every provider", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_LABELS[provider]).toBeTruthy();
    }
  });

  it("validates membership", () => {
    expect(isLlmProvider("anthropic")).toBe(true);
    expect(isLlmProvider("openai")).toBe(true);
    expect(isLlmProvider("bogus")).toBe(false);
    expect(isLlmProvider(undefined)).toBe(false);
  });

  it("marks anthropic, openai, google, and mistral runtime-ready (#204)", () => {
    expect([...RUNTIME_READY_PROVIDERS]).toEqual(["anthropic", "openai", "google", "mistral"]);
    expect(isRuntimeReady("anthropic")).toBe(true);
    expect(isRuntimeReady("openai")).toBe(true);
    expect(isRuntimeReady("google")).toBe(true);
    expect(isRuntimeReady("mistral")).toBe(true);
  });
});
