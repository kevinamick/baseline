"use server";

import { revalidatePath } from "next/cache";
import { requireContributor } from "@/lib/auth/require-contributor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { PLANS, priceIdForPlan, planForPriceId } from "@/lib/billing/plans";
import { isActiveStatus, isEndedStatus } from "@/lib/billing/state";
import { countMembers } from "@/lib/billing/seats";

/**
 * Plan-change lifecycle (#182, ADR-0008). Upgrades apply immediately (Stripe
 * prorates; the webhook's grant reconciliation lands the delta into the
 * current period). Downgrades and cancellations are Stripe-scheduled for
 * period end and reversible until then. The mirror — fed by webhooks — is the
 * page's source of truth; these actions only talk to Stripe.
 *
 * Every action takes no client input beyond intent: the Team comes from the
 * verified auth context, Contributor-gated like checkout.
 */

export type PlanChangeResult = { ok: true } | { error: string };

interface MirrorRow {
  org_id: string;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_schedule_id: string | null;
}

/**
 * The caller's subscription mirror, gated by what the action needs: growing
 * the plan (`requireActive`) needs good standing, but cancelling or reverting
 * a scheduled change must stay available while a LIVE subscription is in
 * payment trouble (past_due/unpaid) — a dunning Team that wants out must not
 * be trapped, and a pending change must stay reversible.
 */
async function mirrorForCaller(opts: {
  requireActive: boolean;
}): Promise<{ orgId: string; userId: string; mirror: MirrorRow } | { error: string }> {
  const gate = await requireContributor("change the plan", "Not signed in");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;

  const { data, error: dbError } = await supabaseAdmin
    .from("customers")
    .select(
      "org_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end, stripe_schedule_id"
    )
    .eq("org_id", orgId)
    .maybeSingle();

  if (dbError) throw dbError;

  if (!data?.stripe_subscription_id || data.status == null || isEndedStatus(data.status)) {
    return { error: "This team has no active subscription" };
  }
  if (opts.requireActive && !isActiveStatus(data.status)) {
    return {
      error: "Plan changes are paused until the payment goes through — update your payment method first.",
    };
  }
  return { orgId, userId, mirror: data as MirrorRow };
}

/**
 * Release a schedule, tolerating the mirror lagging the webhook: if Stripe
 * reports the schedule already released/canceled/completed (e.g. a second
 * click before the `released` event lands), that IS the desired end state.
 */
async function releaseScheduleIfLive(scheduleId: string): Promise<void> {
  try {
    await stripe.subscriptionSchedules.release(scheduleId);
  } catch (err) {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    if (schedule.status === "active" || schedule.status === "not_started") throw err;
  }
}

/** Immediate upgrade to Scale: prorated charge, delta grant via the webhook. */
export async function upgradeToScale(): Promise<PlanChangeResult> {
  const resolved = await mirrorForCaller({ requireActive: true });
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  if (planForPriceId(mirror.stripe_price_id) === "scale") {
    return { error: "This team is already on Scale" };
  }

  try {
    // A pending scheduled change would own the subscription — release it so
    // the upgrade applies cleanly (an upgrade supersedes a scheduled change).
    if (mirror.stripe_schedule_id) {
      await releaseScheduleIfLive(mirror.stripe_schedule_id);
    }
    const sub = await stripe.subscriptions.retrieve(mirror.stripe_subscription_id!);
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: sub.items.data[0].id, price: priceIdForPlan("scale") }],
      // always_invoice bills the proration NOW — the quota delta is granted
      // immediately, so the charge must be too (create_prorations would defer
      // it to the next invoice, letting a Team burn the larger quota unpaid).
      // If the invoice fails, the subscription goes past_due and the quota
      // floor fails closed as usual.
      proration_behavior: "always_invoice",
      cancel_at_period_end: false,
    });
  } catch (err) {
    await log.error("plan upgrade failed", {
      event: "billing.upgrade_failed",
      org_id: orgId,
      error: err,
    });
    return { error: "Couldn't apply the upgrade. Please try again." };
  }

  await track(
    { name: "billing.plan_upgraded", props: { team_id: orgId, plan: "scale" } },
    { userId }
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}

/** Schedule a Scale→Builder downgrade for period end (reversible until then). */
export async function scheduleDowngradeToBuilder(): Promise<PlanChangeResult> {
  const resolved = await mirrorForCaller({ requireActive: true });
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  if (planForPriceId(mirror.stripe_price_id) !== "scale") {
    return { error: "Only Scale teams can switch down to Builder" };
  }
  if (mirror.stripe_schedule_id) {
    return { error: "A plan change is already scheduled" };
  }

  try {
    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: mirror.stripe_subscription_id!,
    });
    const currentPhase = schedule.phases[0];
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release",
      phases: [
        {
          items: [{ price: priceIdForPlan("scale"), quantity: 1 }],
          start_date: currentPhase.start_date,
          end_date: currentPhase.end_date,
        },
        {
          items: [{ price: priceIdForPlan("builder"), quantity: 1 }],
          // One Builder cycle, then the schedule releases the subscription —
          // without this the schedule would own the subscription forever.
          duration: { interval: "month", interval_count: 1 },
        },
      ],
    });
  } catch (err) {
    await log.error("downgrade scheduling failed", {
      event: "billing.downgrade_schedule_failed",
      org_id: orgId,
      error: err,
    });
    return { error: "Couldn't schedule the plan change. Please try again." };
  }

  await track(
    { name: "billing.downgrade_scheduled", props: { team_id: orgId, plan: "builder" } },
    { userId }
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}

/**
 * Schedule a Cancellation: downgrade to Free at period end. Gated on the Free
 * seat cap at schedule time — the wall — and re-checked at execution by the
 * webhook (billing never removes members, it only blocks activity).
 */
export async function cancelPlan(): Promise<PlanChangeResult> {
  const resolved = await mirrorForCaller({ requireActive: false });
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  const seatLimit = PLANS.free.seatLimit ?? 1;
  const memberCount = await countMembers(orgId);
  if (memberCount > seatLimit) {
    return {
      error: `The Free plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}, but your team has ${memberCount} members — remove members to continue.`,
    };
  }

  try {
    // A scheduled paid→paid change owns the subscription; cancelling
    // supersedes it.
    if (mirror.stripe_schedule_id) {
      await releaseScheduleIfLive(mirror.stripe_schedule_id);
    }
    await stripe.subscriptions.update(mirror.stripe_subscription_id!, {
      cancel_at_period_end: true,
    });
  } catch (err) {
    await log.error("cancellation scheduling failed", {
      event: "billing.cancel_schedule_failed",
      org_id: orgId,
      error: err,
    });
    return { error: "Couldn't schedule the cancellation. Please try again." };
  }

  await track(
    { name: "billing.cancellation_scheduled", props: { team_id: orgId } },
    { userId }
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}

/** Reverse any scheduled change (cancellation or downgrade) before it executes. */
export async function keepPlan(): Promise<PlanChangeResult> {
  const resolved = await mirrorForCaller({ requireActive: false });
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  if (!mirror.cancel_at_period_end && !mirror.stripe_schedule_id) {
    return { error: "No scheduled change to keep your plan from" };
  }

  try {
    if (mirror.stripe_schedule_id) {
      await releaseScheduleIfLive(mirror.stripe_schedule_id);
    }
    if (mirror.cancel_at_period_end) {
      await stripe.subscriptions.update(mirror.stripe_subscription_id!, {
        cancel_at_period_end: false,
      });
    }
  } catch (err) {
    await log.error("scheduled-change revert failed", {
      event: "billing.keep_plan_failed",
      org_id: orgId,
      error: err,
    });
    return { error: "Couldn't revert the scheduled change. Please try again." };
  }

  await track(
    { name: "billing.scheduled_change_reverted", props: { team_id: orgId } },
    { userId }
  );
  revalidatePath("/settings/billing");
  return { ok: true };
}
