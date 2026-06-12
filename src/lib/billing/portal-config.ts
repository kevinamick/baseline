import "server-only";
import { stripe } from "@/lib/stripe";

/**
 * The restricted Stripe Customer Portal configuration (#191): payment method,
 * billing email/address, and invoice history ONLY. Cancellation and plan
 * switching are deliberately disabled — those are in-app flows (S5/#182)
 * because downgrade constraints are enforced at schedule time, which the
 * portal cannot do.
 *
 * Resolution order: STRIPE_PORTAL_CONFIG_ID env (explicit pin, e.g. prod) →
 * an existing configuration tagged with our marker → create one. The id is
 * cached per process; the marker keeps lookups idempotent across instances.
 */

const CONFIG_MARKER = "baseline_billing_page_v1";

let cachedId: string | null = null;

export async function getPortalConfigurationId(): Promise<string> {
  const pinned = process.env.STRIPE_PORTAL_CONFIG_ID;
  if (pinned) return pinned;
  if (cachedId) return cachedId;

  const existing = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  const found = existing.data.find(
    (c) => c.metadata?.baseline === CONFIG_MARKER
  );
  if (found) {
    cachedId = found.id;
    return found.id;
  }

  const created = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: "Baseline — manage your team's billing details",
    },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: {
        enabled: true,
        allowed_updates: ["email", "address", "name"],
      },
      // In-app flows, never portal flows (ADR-0008 schedule-time constraints).
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    },
    metadata: { baseline: CONFIG_MARKER },
  });
  cachedId = created.id;
  return created.id;
}

/** Test seam: reset the per-process cache. */
export function resetPortalConfigCache(): void {
  cachedId = null;
}
