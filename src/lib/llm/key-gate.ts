import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";
import { RUNTIME_READY_PROVIDERS, type LlmProvider } from "@/lib/llm/providers";
import { ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";

/**
 * Whether a Team's eval run must be blocked for want of a provider key (#184).
 *
 * Free Teams have no managed-key fallback (no card on file → unbounded token
 * exposure, ADR-0008), so they must bring their own key for the runtime provider
 * or their runs fail closed. Paid Teams fall back to the managed platform key
 * and are never blocked here — `managedMarkupPct != null` is exactly the
 * "managed allowed" signal (Free is null; Builder/Scale are non-null).
 *
 * "Has a key" means a key exists for at least one runtime-ready provider — the
 * only provider whose key can actually be used at run time today. (The worker
 * resolves the provider from the model a run will call; while Anthropic is the
 * sole runtime-ready provider the two are equivalent. Revisit when a second
 * runtime provider lands so the gate and the worker agree.) Fails closed: an
 * unreadable key table leaves a Free Team blocked, never waved through.
 */
export async function evalRunBlockedForMissingKey(orgId: string): Promise<boolean> {
  const { plan } = await getBillingState(orgId);
  if (PLANS[plan].managedMarkupPct != null) return false;
  return !(await hasRuntimeProviderKey(orgId));
}

async function hasRuntimeProviderKey(orgId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("provider_keys")
    .select("provider")
    .eq("org_id", orgId)
    .in("provider", RUNTIME_READY_PROVIDERS as unknown as string[])
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/** How a managed-metering run resolves its key for a given provider. */
export type KeyMode = "byo" | "managed" | "blocked";

/**
 * Resolve a Team's key mode for one provider, mirroring the worker's run-time
 * precedence (worker/src/providers/resolve-key.ts) so the app's pre-run dollar
 * estimate and managed-spend reservation agree with what the worker will do:
 *   - a BYO key for the provider → "byo" (any plan; the customer's tokens, never metered)
 *   - no BYO key + paid plan (managedMarkupPct != null) → "managed" (metered, capped)
 *   - no BYO key + Free → "blocked" (no managed fallback, ADR-0008)
 * The worker stays the run-time source of truth; this only drives the estimate
 * and the pre-run reserve (#185).
 */
export async function resolveKeyModeForEstimate(
  orgId: string,
  provider: LlmProvider,
): Promise<KeyMode> {
  const { data } = await supabaseAdmin
    .from("provider_keys")
    .select("provider")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (data) return "byo";

  const { plan } = await getBillingState(orgId);
  return PLANS[plan].managedMarkupPct != null ? "managed" : "blocked";
}

/**
 * The plan to price a pre-run managed-spend estimate against, or null when no
 * estimate applies (the Team runs BYO, or is Free/blocked). Drives the run
 * dialog's "~$ est. managed spend" line (#185). Resolved for the judge model's
 * provider, matching what the worker meters.
 */
export async function managedEstimatePlanForOrg(
  orgId: string,
): Promise<PlanSlug | null> {
  const mode = await resolveKeyModeForEstimate(orgId, ESTIMATE_JUDGE_PROVIDER);
  if (mode !== "managed") return null;
  const { plan } = await getBillingState(orgId);
  return plan;
}
