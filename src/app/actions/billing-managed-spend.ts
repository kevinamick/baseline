"use server";

import { revalidatePath } from "next/cache";
import { requireContributor } from "@/lib/auth/require-contributor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { getTrustStatus } from "@/lib/billing/trust";
import { fmtUsd } from "@/lib/billing/format";

/**
 * Managed Spend Cap settings (#185, ADR-0008 Meter 2). The cap bounds managed
 * token spend (paid Teams on the platform key). Each plan ships a default
 * (Builder $25 / Scale $100); a Team can RAISE or lower it. Contributor-gated
 * like every billing action; resetting to the plan default is always allowed.
 * Unlike the Overage Cap, there's no "off" — managed spend is always capped
 * (an unbounded managed plan would mean unbounded provider exposure).
 *
 * How high a Team may raise it is the *trust ceiling* (#188, ADR-0008): it starts
 * at the plan default and rises with paid-invoice history (lib/billing/trust). The
 * raise is enforced here, server-side — the only write path — so a brand-new Team
 * cannot self-raise past its initial ceiling by any sequence of UI/API actions.
 */

export type ManagedSpendCapResult = { ok: true } | { error: string };

export async function setManagedSpendCap(
  formData: FormData,
): Promise<ManagedSpendCapResult> {
  const gate = await requireContributor("changeBillingSettings", "notSignedIn");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;

  const raw = String(formData.get("capUsd") ?? "").trim();
  const capUsd = Number(raw);
  if (!raw || !Number.isFinite(capUsd)) {
    return { error: "Enter a dollar amount for the cap" };
  }
  // Tolerance, not equality (binary float): mirrors setOverageCap.
  if (Math.abs(capUsd * 100 - Math.round(capUsd * 100)) > 1e-6) {
    return { error: "The cap can't be more precise than cents" };
  }
  if (capUsd < 1) return { error: "The cap must be at least $1" };

  const billing = await getBillingState(orgId);
  if (!billing.active || PLANS[billing.plan].managedMarkupPct == null) {
    return { error: "Managed spend applies to active paid plans only" };
  }

  // Trust escalation (#188): a raise is bounded by the Team's trust ceiling, which
  // grows with paid-invoice history. Lowering is always fine — only raises above
  // the ceiling are refused, with legible copy on how the ceiling grows.
  const trust = await getTrustStatus(orgId);
  if (trust.ceilingUsd != null && capUsd > trust.ceilingUsd) {
    const grow = trust.nextTier
      ? ` Pay ${trust.nextTier.atPaidInvoices - trust.paidInvoices} more invoice${
          trust.nextTier.atPaidInvoices - trust.paidInvoices === 1 ? "" : "s"
        } on time to raise it to ${fmtUsd(trust.nextTier.ceilingUsd)}.`
      : "";
    return {
      error: `Your team's cap ceiling is ${fmtUsd(trust.ceilingUsd)} right now — it grows with your paid-invoice history.${grow}`,
    };
  }

  const { error } = await supabaseAdmin.from("billing_settings").upsert({
    org_id: orgId,
    managed_spend_cap_usd: capUsd,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  });
  if (error) {
    await log.error("managed spend cap update failed", {
      event: "billing.managed_spend_cap_update_failed",
      org_id: orgId,
      error,
    });
    return { error: "Couldn't save the cap. Please try again." };
  }

  await track(
    { name: "billing.managed_spend_cap_set", props: { team_id: orgId, cap_usd: capUsd } },
    { userId },
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}

/**
 * Reset the Managed Spend Cap to the plan default (clears the Team override).
 * Always allowed — a Team can fall back to the plan's default ceiling any time.
 */
export async function resetManagedSpendCap(): Promise<ManagedSpendCapResult> {
  const gate = await requireContributor("changeBillingSettings", "notSignedIn");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;

  const { error } = await supabaseAdmin
    .from("billing_settings")
    .update({
      managed_spend_cap_usd: null,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq("org_id", orgId);
  if (error) {
    await log.error("managed spend cap reset failed", {
      event: "billing.managed_spend_cap_update_failed",
      org_id: orgId,
      error,
    });
    return { error: "Couldn't reset the cap. Please try again." };
  }

  await track(
    { name: "billing.managed_spend_cap_cleared", props: { team_id: orgId } },
    { userId },
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}
