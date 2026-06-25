import "server-only";
import { LLM_PROVIDERS, isRuntimeReady, type LlmProvider } from "@/lib/llm/providers";
import { resolveKeyModeForEstimate, KEY_MODE } from "@/lib/llm/key-gate";
import { MODEL_PRICES } from "@/lib/llm/model-prices";

/**
 * A provider a Team can actually run an optimization on, and which key the run will use (#204):
 *   - "byo"     — the Team stored a key for this provider (any plan; its own tokens)
 *   - "managed" — no BYO key, but the Team is on a paid plan that falls back to Baseline's key
 * A provider the Team can't use (no BYO key + Free, or not runtime-ready) is omitted, so the
 * wizard only ever offers providers a run could use.
 */
export interface UsableProvider {
  provider: LlmProvider;
  keySource: "byo" | "managed";
}

function providerHasPricedModels(provider: LlmProvider): boolean {
  return Object.keys(MODEL_PRICES[provider] ?? {}).length > 0;
}

/**
 * Resolve which providers a Team can run an optimization on, mirroring the worker's run-time key
 * precedence (resolve-key.ts) via resolveKeyModeForEstimate so the wizard agrees with what the
 * worker will do. A managed fallback additionally requires the provider to be priced (an unpriced
 * managed call fails closed, ADR-0008), so a provider that's managed-eligible but unpriced is
 * omitted. BYO never requires pricing (the customer pays their provider directly).
 */
export async function usableProvidersForOrg(orgId: string): Promise<UsableProvider[]> {
  const modes = await Promise.all(
    LLM_PROVIDERS.filter(isRuntimeReady).map(async (provider) => ({
      provider,
      mode: await resolveKeyModeForEstimate(orgId, provider),
    })),
  );
  const out: UsableProvider[] = [];
  for (const { provider, mode } of modes) {
    if (mode === KEY_MODE.byo) {
      out.push({ provider, keySource: "byo" });
    } else if (mode === KEY_MODE.managed && providerHasPricedModels(provider)) {
      out.push({ provider, keySource: "managed" });
    }
  }
  return out;
}
