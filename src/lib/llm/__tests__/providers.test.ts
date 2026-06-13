import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  RUNTIME_READY_PROVIDERS,
  isLlmProvider,
  isRuntimeReady,
} from "@/lib/llm/providers";

// The canonical provider set. The worker's provider-list.test.ts pins the SAME
// literal — the app and worker arrays must stay identical (single source, #184).
const CANONICAL = ["anthropic", "openai", "google"];

describe("LLM_PROVIDERS (#184)", () => {
  it("ships the canonical provider set (parity with the worker)", () => {
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

  it("marks only Anthropic runtime-ready today", () => {
    expect([...RUNTIME_READY_PROVIDERS]).toEqual(["anthropic"]);
    expect(isRuntimeReady("anthropic")).toBe(true);
    expect(isRuntimeReady("openai")).toBe(false);
    expect(isRuntimeReady("google")).toBe(false);
  });
});
