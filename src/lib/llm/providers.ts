/**
 * Single source for the LLM providers a Team can store a BYO key for (#184).
 * One const list; the type, the validator, and the UI labels are all derived
 * from it — no duplicated unions (the project's enum convention).
 *
 * ADR-0008 is provider-agnostic by construction: nothing downstream hardcodes a
 * provider. The DB check constraint, the settings UI rows, and the worker's
 * key resolution all iterate/derive from this list. Adding a provider is a
 * one-line change here (plus the matching migration to widen the constraint and
 * a worker SDK client to make it runtime-ready).
 *
 * The worker keeps its own copy at worker/src/providers/provider-list.ts (a
 * separate project pending the shared-package extraction in #93); the parity test
 * in __tests__/providers.test.ts imports both arrays and asserts they're equal,
 * so a drift in either file fails CI.
 */

export const LLM_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === "string" &&
    (LLM_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Display names for the settings UI. */
export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/**
 * Providers with a runtime SDK client wired in the worker today. Storage works
 * for every provider in LLM_PROVIDERS; only a runtime-ready provider's key is
 * actually used at run time. The others save fine but render a "Coming soon"
 * badge in the UI — keys aren't silently ignored (billing-transparency
 * principle). A provider goes runtime-ready by adding it here and wiring its
 * client in the worker.
 */
export const RUNTIME_READY_PROVIDERS = [
  "anthropic",
] as const satisfies readonly LlmProvider[];

export function isRuntimeReady(provider: LlmProvider): boolean {
  return (RUNTIME_READY_PROVIDERS as readonly LlmProvider[]).includes(provider);
}
