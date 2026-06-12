"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { PLANS, priceIdForPlan, planForPriceId } from "@/lib/billing/plans";
import { isActiveStatus } from "@/lib/billing/state";

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

async function activeMirrorForCaller(): Promise<
  { orgId: string; userId: string; mirror: MirrorRow } | { error: string }
> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not signed in" };
  if (!canWrite) return { error: "Only contributors can change the plan" };

  const { data } = await supabaseAdmin
    .from("customers")
    .select(
      "org_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end, stripe_schedule_id"
    )
    .eq("org_id", orgId)
    .maybeSingle();

  if (!data?.stripe_subscription_id || !isActiveStatus(data.status)) {
    return { error: "This team has no active subscription" };
  }
  return { orgId, userId, mirror: data as MirrorRow };
}

/** Immediate upgrade to Scale: prorated charge, delta grant via the webhook. */
export async function upgradeToScale(): Promise<PlanChangeResult> {
  const resolved = await activeMirrorForCaller();
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  if (planForPriceId(mirror.stripe_price_id) === "scale") {
    return { error: "This team is already on Scale" };
  }

  try {
    // A pending scheduled change would own the subscription — release it so
    // the upgrade applies cleanly (an upgrade supersedes a scheduled change).
    if (mirror.stripe_schedule_id) {
      await stripe.subscriptionSchedules.release(mirror.stripe_schedule_id);
    }
    const sub = await stripe.subscriptions.retrieve(mirror.stripe_subscription_id!);
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: sub.items.data[0].id, price: priceIdForPlan("scale") }],
      proration_behavior: "create_prorations",
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
  const resolved = await activeMirrorForCaller();
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
  const resolved = await activeMirrorForCaller();
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  const seatLimit = PLANS.free.seatLimit ?? 1;
  const { count } = await supabaseAdmin
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId);
  if ((count ?? 0) > seatLimit) {
    return {
      error: `The Free plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}, but your team has ${count} members — remove members to continue.`,
    };
  }

  try {
    // A scheduled paid→paid change owns the subscription; cancelling
    // supersedes it.
    if (mirror.stripe_schedule_id) {
      await stripe.subscriptionSchedules.release(mirror.stripe_schedule_id);
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
  const resolved = await activeMirrorForCaller();
  if ("error" in resolved) return resolved;
  const { orgId, userId, mirror } = resolved;

  if (!mirror.cancel_at_period_end && !mirror.stripe_schedule_id) {
    return { error: "No scheduled change to keep your plan from" };
  }

  try {
    if (mirror.stripe_schedule_id) {
      await stripe.subscriptionSchedules.release(mirror.stripe_schedule_id);
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
