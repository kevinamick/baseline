import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  RUNTIME_READY_PROVIDERS,
  isLlmProvider,
  isRuntimeReady,
} from "@/lib/llm/providers";
// The worker keeps its own copy (separate project, #93). This test imports it
// directly and asserts equality below, so the two arrays are mechanically pinned
// together — a drift in either file fails this test.
import { LLM_PROVIDERS as WORKER_PROVIDERS } from "../../../../worker/src/providers/provider-list";

const CANONICAL = ["anthropic", "openai", "google", "mistral"];

describe("LLM_PROVIDERS (#184)", () => {
  it("ships the canonical provider set", () => {
    expect([...LLM_PROVIDERS]).toEqual(CANONICAL);
  });

  it("stays identical to the worker's copy (mechanical parity)", () => {
    expect([...LLM_PROVIDERS]).toEqual([...WORKER_PROVIDERS]);
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
