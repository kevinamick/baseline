import "server-only";
import { LLM_PROVIDERS, isRuntimeReady, type LlmProvider } from "@/lib/llm/providers";
import { resolveKeySources, KEY_SOURCE, type KeySource } from "@/lib/llm/key-gate";

/**
 * A provider the Workspace can actually run an optimization on, and which key the run
 * will use (ADR-0020): "vault" (a key pasted into Settings) or "env" (the operator's
 * `<PROVIDER>_API_KEY`). A provider with neither, or one that isn't runtime-ready, is
 * omitted so the wizard only ever offers providers a run could use.
 */
export interface UsableProvider {
  provider: LlmProvider;
  keySource: Exclude<KeySource, "none">;
}

/**
 * Resolve which providers the Workspace can run on, mirroring the worker's run-time key
 * precedence (resolve-key.ts) so the wizard agrees with what the worker will do.
 */
export async function usableProvidersForOrg(orgId: string): Promise<UsableProvider[]> {
  const providers = LLM_PROVIDERS.filter(isRuntimeReady);
  const sources = await resolveKeySources(orgId, providers);
  const out: UsableProvider[] = [];
  for (const provider of providers) {
    const source = sources.get(provider);
    if (source && source !== KEY_SOURCE.none) out.push({ provider, keySource: source });
  }
  return out;
}
