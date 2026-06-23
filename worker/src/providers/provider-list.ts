// Worker copy of the LLM provider const list (#184). Must stay identical to the
// app's src/lib/llm/providers.ts LLM_PROVIDERS array — the worker is a separate
// project pending the shared-package extraction (#93). The app's parity test
// imports this file and asserts the two arrays are equal, so a drift fails CI.
// No imports here on purpose: the app test runner imports this file directly.

export const LLM_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === "string" &&
    (LLM_PROVIDERS as readonly string[]).includes(value)
  );
}

// Managed platform key per provider — the paid-plan fallback when a Team has no
// BYO key. One env var each; no single hardcoded ANTHROPIC_API_KEY assumption.
// A provider with no managed key configured (or not paid-eligible) resolves to
// "none" and the run fails closed.
export const MANAGED_KEY_ENV: Record<LlmProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
};
