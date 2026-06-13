"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { getBillingState } from "@/lib/billing/state";
import { overageRatesForPlan } from "@/lib/billing/overage";

/**
 * Overage Cap settings (#183, ADR-0008). Opting in IS typing a cap — there is
 * no bare toggle, and no code path bills overage without one. Contributor-
 * gated like every billing action; the cap requires an actively-paid plan
 * with overage rates (Free has no overage option). Clearing is always
 * allowed: turning billing exposure OFF must never be gated.
 */

export type OverageCapResult = { ok: true } | { error: string };

/** Sanity ceiling — ADR-0008's trust escalation (S11) will own real limits. */
const MAX_CAP_USD = 10_000;

export async function setOverageCap(formData: FormData): Promise<OverageCapResult> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not signed in" };
  if (!canWrite) return { error: "Only contributors can change billing settings" };

  const raw = String(formData.get("capUsd") ?? "").trim();
  const capUsd = Number(raw);
  if (!raw || !Number.isFinite(capUsd)) {
    return { error: "Enter a dollar amount for the cap" };
  }
  // Tolerance, not equality: $4.35 × 100 is 434.99999999999994 in binary
  // floating point — exact comparison rejects ~13% of valid cent amounts.
  if (Math.abs(capUsd * 100 - Math.round(capUsd * 100)) > 1e-6) {
    return { error: "The cap can't be more precise than cents" };
  }
  if (capUsd < 1) return { error: "The cap must be at least $1" };
  if (capUsd > MAX_CAP_USD) {
    return { error: `The cap can't exceed $${MAX_CAP_USD.toLocaleString("en-US")} for now` };
  }

  const billing = await getBillingState(orgId);
  if (!billing.active || !overageRatesForPlan(billing.plan)) {
    return { error: "Overage is available on active paid plans only" };
  }

  const { error } = await supabaseAdmin.from("billing_settings").upsert({
    org_id: orgId,
    overage_cap_usd: capUsd,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  });
  if (error) {
    await log.error("overage cap update failed", {
      event: "billing.overage_cap_update_failed",
      org_id: orgId,
      error,
    });
    return { error: "Couldn't save the cap. Please try again." };
  }

  await track(
    { name: "billing.overage_cap_set", props: { team_id: orgId, cap_usd: capUsd } },
    { userId }
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}

/**
 * Turn overage off. In-flight overage reservations stand and settle honestly
 * (the work was authorized when reserved); only NEW work past included is
 * blocked from here on.
 */
export async function clearOverageCap(): Promise<OverageCapResult> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not signed in" };
  if (!canWrite) return { error: "Only contributors can change billing settings" };

  const { error } = await supabaseAdmin
    .from("billing_settings")
    .update({
      overage_cap_usd: null,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq("org_id", orgId);
  if (error) {
    await log.error("overage cap clear failed", {
      event: "billing.overage_cap_update_failed",
      org_id: orgId,
      error,
    });
    return { error: "Couldn't turn overage off. Please try again." };
  }

  await track(
    { name: "billing.overage_cap_cleared", props: { team_id: orgId } },
    { userId }
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}