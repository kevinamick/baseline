import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/billing/plans";
import { resolvePointPeriod } from "@/lib/billing/ledger";
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
 * currently resolves "anthropic" specifically; while it's the sole runtime-ready
 * provider the two are equivalent. When a second runtime provider lands, revisit
 * this so the gate and the worker agree on which provider a run will use.)
 * Returns the
 * current period start so the caller can throttle the Contributor email once per
 * period (the billing_notifications PK). Fails closed: an unreadable key table
 * leaves a Free Team blocked, never waved through.
 */
export async function evalRunBlockedForMissingKey(
  orgId: string
): Promise<{ blocked: false } | { blocked: true; periodStart: string }> {
  const { plan, start } = await resolvePointPeriod(orgId);
  if (PLANS[plan].managedMarkupPct != null) return { blocked: false };
  if (await hasRuntimeProviderKey(orgId)) return { blocked: false };
  return { blocked: true, periodStart: start.toISOString() };
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
