import "server-only";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";

// Managed Agent paid gate (#292). A Managed Agent runs on Baseline's managed key — a paid-plan
// feature — so a Free/unpaid Team can neither select nor inline-create one (managedMarkupPct ==
// null ⇔ Free). Returns the upgrade reason when the Team is gated, or null when allowed.
//
// Shared by the Connection and Schedule server actions, which both refuse a Managed Agent at
// create time; the worker claim path enforces the same invariant in gateScheduledRunBilling.
export async function managedGateError(orgId: string): Promise<string | null> {
  const { plan } = await getBillingState(orgId);
  if (PLANS[plan].managedMarkupPct != null) return null;
  return "Managed Agents are a paid-plan feature — they run on Baseline's managed key. Upgrade under Settings → Billing, or choose an agent that uses your own endpoint or provider key.";
}
