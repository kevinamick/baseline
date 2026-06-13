import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";
import { RUNTIME_READY_PROVIDERS } from "@/lib/llm/providers";

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
