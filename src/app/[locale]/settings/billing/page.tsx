import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPointBudget, listLedgerEntries, type LedgerEntry } from "@/lib/billing/ledger";
import { after } from "next/server";
import { getOptimizationAllowance } from "@/lib/billing/allowance";
import {
  getOverageCap,
  hasDirtyOverageLines,
  overageRatesForPlan,
  projectedOverageUsd,
} from "@/lib/billing/overage";
import { syncOverageInvoiceItems } from "@/lib/billing/overage-sync";
import {
  getEffectiveManagedCap,
  getManagedSpendTotal,
  getManagedSpendEntries,
} from "@/lib/billing/managed-spend";
import { getTrustStatus } from "@/lib/billing/trust";
import { getBillingState, isEndedStatus } from "@/lib/billing/state";
import { countMembers } from "@/lib/billing/seats";
import { PLANS, planForPriceId, isPaidPlanSlug } from "@/lib/billing/plans";
import { evalRunPointsPerRow } from "@/lib/billing/points";
import { fmtRate } from "@/lib/billing/format";
import { openBillingPortal } from "@/app/actions/billing-portal";
import { pillBtnCls } from "@/app/_components/form-styles";
import { PlanActions } from "./_components/plan-actions";
import { OverageCap } from "./_components/overage-cap";
import { ManagedSpendCap } from "./_components/managed-spend-cap";

/**
 * Team billing page — the hub (#191): current Plan, subscription status,
 * plan changes & Cancellation (#182), "Manage billing" via the restricted
 * Stripe Customer Portal, plus the Eval Point balance and Point Ledger from
 * #180. Contributor-only, same gate as Team settings. The full usage meters
 * arrive with S13 (#192).
 */
export default async function BillingSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Settings.billing" });

  const { canWrite, orgId } = await getAuthContext();
  if (!canWrite || !orgId) {
    redirect("/rubrics");
  }

  const [billing, budget, { data: customer, error: customerErr }, memberCount] = await Promise.all([
    getBillingState(orgId),
    getPointBudget(orgId),
    // The portal precondition is the Stripe customer itself — checked directly,
    // not inferred from status: a checkout.session.completed upsert creates the
    // row before the subscription event fills the status in.
    supabaseAdmin
      .from("customers")
      .select("stripe_customer_id")
      .eq("org_id", orgId)
      .maybeSingle(),
    countMembers(orgId),
  ]);
  if (customerErr) throw customerErr;
  const [
    entries,
    allowance,
    rawCap,
    dirtyLines,
    managedCap,
    managedSpent,
    managedEntries,
    trust,
  ] = await Promise.all([
    listLedgerEntries(orgId, budget.periodStart),
    getOptimizationAllowance(orgId),
    getOverageCap(orgId),
    hasDirtyOverageLines(orgId),
    getEffectiveManagedCap(orgId),
    getManagedSpendTotal(orgId, budget.periodStart),
    getManagedSpendEntries(orgId, budget.periodStart),
    getTrustStatus(orgId),
  ]);
  // Overage posture (#183): negative balances are committed overage. The
  // rates come from the quota tier, so a floored (past_due/free) Team shows
  // no overage card at all (and its cap, if any, is dormant).
  const overageRates = overageRatesForPlan(budget.plan);
  const overage = overageRates
    ? {
        rates: overageRates,
        capUsd: rawCap,
        pointsOver: Math.max(0, -budget.balance),
        runsOver: Math.max(0, -allowance.remaining),
        committedUsd: projectedOverageUsd(budget.balance, allowance.remaining, overageRates),
      }
    : null;
  // Opportunistic Stripe push: settled overage the worker recorded gets
  // invoiced the next time anyone looks at billing. Runs via after() so a
  // slow Stripe can never stall this page and serverless doesn't drop the
  // promise mid-flight; the invoice.created webhook is the period-end
  // backstop either way.
  if (overage && dirtyLines) {
    after(() => syncOverageInvoiceItems(orgId));
  }
  // Managed token spend posture (#185, ADR-0008 Meter 2). Shown only when the
  // quota tier in force allows managed keys (managedMarkupPct != null) — a floored
  // (past_due/free) Team shows no managed card, matching the overage card's rule.
  const managedMarkupPct = PLANS[budget.plan].managedMarkupPct;
  const managed =
    managedMarkupPct != null && managedCap.capUsd != null
      ? {
          capUsd: managedCap.capUsd,
          isDefault: managedCap.isDefault,
          defaultCapUsd: PLANS[budget.plan].defaultManagedSpendCapUsd ?? managedCap.capUsd,
          spentUsd: managedSpent,
          markupPct: managedMarkupPct,
          entries: managedEntries,
          // Trust escalation (#188): the ceiling a raise is bounded by, and how it
          // grows. ceilingUsd is null only when managed is N/A — guarded above — so
          // fall back to the effective cap to keep the type non-null for the card.
          ceilingUsd: trust.ceilingUsd ?? managedCap.capUsd,
          nextTier: trust.nextTier,
        }
      : null;

  // The quota tier in force — what the Eval Points card meters against.
  const plan = PLANS[budget.plan];
  // The plan card names the SUBSCRIBED plan from the mirrored price id while
  // the subscription EXISTS — even out of good standing: a past_due/unpaid
  // Builder Team is still "Builder" with a status chip, not silently "Free"
  // (Kevin, 2026-06-12; only the quota tier floors). An ENDED subscription is
  // no longer subscribed: the card floors.
  const subscribed = billing.status != null && !isEndedStatus(billing.status);
  const cardPlan =
    PLANS[subscribed ? planForPriceId(billing.priceId) ?? budget.plan : budget.plan];
  // The two live payment-failure states get the chip and the recovery banner.
  const paymentFailed = billing.status === "past_due" || billing.status === "unpaid";
  const hasBillingAccount = Boolean(customer?.stripe_customer_id);

  // Pinned to UTC: dates come from the Stripe mirror in UTC, and the rendered
  // day must not depend on whichever timezone the server happens to run in.
  // Formatted in the active locale so the chrome around them reads naturally.
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  const resetDate = fmtDate(budget.periodEnd);
  const renewalDate = billing.currentPeriodEnd ? fmtDate(billing.currentPeriodEnd) : null;
  const fmt = (n: number) => n.toLocaleString(locale);

  // Scheduled changes (#182): a Cancellation or a paid→paid downgrade renders
  // as a pending line ("Scale until <date>, then Builder") with the undo —
  // only while the subscription still exists (an executed cancellation keeps
  // cancel_at_period_end on the mirror, but there's nothing pending anymore).
  // One object so kind, target, and date can never disagree.
  const subscribedPlan = planForPriceId(billing.priceId);
  const pendingChange = !subscribed
    ? null
    : billing.cancelAtPeriodEnd
      ? { kind: "cancel" as const, target: "Free", date: renewalDate }
      : billing.pendingPriceId
        ? {
            kind: "downgrade" as const,
            target: PLANS[planForPriceId(billing.pendingPriceId) ?? "free"].name,
            date: billing.pendingChangeAt ? fmtDate(billing.pendingChangeAt) : renewalDate,
          }
        : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">{t("title")}</h1>
        <p className="mt-1 text-sm text-fg-2">{t("subtitle")}</p>

        <section
          data-testid="plan-card"
          className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium text-fg-2">{t("plan.heading")}</h2>
              <p className="mt-1 flex items-center gap-2.5 text-2xl font-semibold tracking-[-0.01em] text-ink">
                {cardPlan.name}
                <span className="text-sm font-normal text-fg-3">
                  {t("plan.perMonth", { price: cardPlan.monthlyPriceUsd })}
                </span>
                {paymentFailed && (
                  <span
                    data-testid="plan-status-chip"
                    className="rounded-full border border-danger px-2.5 py-0.5 text-xs font-medium text-danger-fg"
                  >
                    {t("plan.paymentFailedChip")}
                  </span>
                )}
              </p>
              <p className="mt-1 text-sm text-fg-2" data-testid="plan-subline">
                {pendingChange
                  ? t("plan.pendingChange", {
                      plan: cardPlan.name,
                      date: pendingChange.date ?? "",
                      target: pendingChange.target,
                    })
                  : billing.active && renewalDate
                    ? t("plan.renews", { date: renewalDate })
                    : paymentFailed
                      ? t("plan.paymentFailedSubline")
                      : hasBillingAccount
                        ? t("plan.noSubscription")
                        : t("plan.freePlan")}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {hasBillingAccount ? (
                <form action={openBillingPortal}>
                  <button type="submit" className={pillBtnCls}>
                    {t("plan.manageBilling")}
                  </button>
                </form>
              ) : (
                <Link href="/pricing" className={pillBtnCls}>
                  {t("plan.comparePlans")}
                  <span aria-hidden="true"> →</span>
                </Link>
              )}
              {/* Plan changes are offered while the subscription exists — a
                  past_due/unpaid Team must still be able to cancel, or revert
                  a scheduled change; upgrades need good standing. */}
              {subscribed && isPaidPlanSlug(subscribedPlan) && (
                <PlanActions
                  plan={subscribedPlan}
                  periodEndLabel={renewalDate}
                  pending={pendingChange?.kind ?? null}
                  memberCount={memberCount}
                  upgradeAllowed={billing.active}
                />
              )}
            </div>
          </div>
          {paymentFailed && (
            <p
              data-testid="payment-failed-banner"
              className="mt-4 rounded-lg border border-danger bg-card px-4 py-3 text-sm text-danger-fg"
            >
              {t.rich("plan.paymentFailedBanner", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          )}
        </section>

        <section className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium text-ink">{t("points.heading")}</h2>
            <span className="text-xs text-fg-3">{t("points.resets", { date: resetDate })}</span>
          </div>
          <p className="mt-3 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink" data-testid="point-balance">
            {fmt(Math.max(0, budget.balance))}
            <span className="ml-1.5 text-sm font-normal text-fg-3">
              {t("points.remaining", { included: fmt(budget.included) })}
            </span>
          </p>
          {/* The real block condition is per-run (cost > balance); below the
              cheapest possible run (1 row × 1 criterion) every run is refused,
              so that is the honest "effectively exhausted" line — unless a
              cap with headroom keeps runs going (#183). */}
          {budget.balance < evalRunPointsPerRow(1) &&
            !(overage && overage.capUsd != null && overage.committedUsd < overage.capUsd) && (
              <p className="mt-2 text-sm text-danger-fg" data-testid="points-exhausted">
                {t("points.exhausted", {
                  suffix: plan.slug === "free" ? t("points.exhaustedSuffix") : "",
                })}
              </p>
            )}
        </section>

        {overage && (
          <OverageCap
            capUsd={overage.capUsd}
            committedUsd={overage.committedUsd}
            pointsOver={overage.pointsOver}
            runsOver={overage.runsOver}
            pointUnitUsd={overage.rates.pointUnitUsd}
            runUnitUsd={overage.rates.runUnitUsd}
          />
        )}

        {managed && (
          <>
            <ManagedSpendCap
              capUsd={managed.capUsd}
              isDefault={managed.isDefault}
              defaultCapUsd={managed.defaultCapUsd}
              spentUsd={managed.spentUsd}
              markupPct={managed.markupPct}
              ceilingUsd={managed.ceilingUsd}
              nextTier={managed.nextTier}
            />
            <section className="mt-6">
              <h2 className="text-sm font-medium text-ink">{t("managedUsage.heading")}</h2>
              <p className="mt-1 text-xs text-fg-3">
                {t("managedUsage.blurb", { pct: managed.markupPct })}
              </p>
              {managed.entries.length === 0 ? (
                <p className="mt-3 text-sm text-fg-2">
                  {t("managedUsage.empty")}
                </p>
              ) : (
                <ul
                  data-testid="managed-usage-ledger"
                  className="mt-3 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card"
                >
                  {managed.entries.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink">
                          {e.model ?? "—"}
                          <span className="ml-1.5 text-xs text-fg-3">
                            {e.callKind === "reflect"
                              ? t("managedUsage.reflection")
                              : e.callKind === "agent"
                                ? t("managedUsage.agent")
                                : t("managedUsage.judge")}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-fg-3">
                          {new Date(e.createdAt).toLocaleString(locale, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                          {e.inputTokens != null && e.outputTokens != null && (
                            <>
                              {" · "}
                              {t("managedUsage.tokens", {
                                input: fmt(e.inputTokens),
                                output: fmt(e.outputTokens),
                              })}
                            </>
                          )}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-ink">
                        {fmtRate(e.costUsd)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink">{t("ledger.heading")}</h2>
          <p className="mt-1 text-xs text-fg-3">{t("ledger.blurb")}</p>
          {entries.length === 0 ? (
            <p className="mt-3 text-sm text-fg-2">{t("ledger.empty")}</p>
          ) : (
            <ul
              data-testid="point-ledger"
              className="mt-3 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card"
            >
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{t(`ledger.${e.entryType}`)}</p>
                    <p className="mt-0.5 text-xs text-fg-3">
                      {new Date(e.createdAt).toLocaleString(locale, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {e.evalRunId && <> · {t("ledger.run", { id: e.evalRunId.slice(0, 8) })}</>}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-sm font-semibold tabular-nums ${entryTone(e)}`}
                  >
                    {entryAmount(e)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * One row per entry type so sign and tone can never disagree. Signed display
 * follows the balance math: grant/release add, reserve subtracts, settle is
 * balance-neutral (the reservation already paid). The human label is keyed in
 * the Settings.billing.ledger catalog by entryType.
 */
const ENTRY_DISPLAY: Record<
  LedgerEntry["entryType"],
  { sign: "+" | "−" | ""; tone: string }
> = {
  grant: { sign: "+", tone: "text-success-fg" },
  upgrade: { sign: "+", tone: "text-success-fg" },
  reserve: { sign: "−", tone: "text-danger-fg" },
  settle: { sign: "", tone: "text-fg-3" },
  release: { sign: "+", tone: "text-success-fg" },
};

function entryAmount(e: LedgerEntry): string {
  const d = ENTRY_DISPLAY[e.entryType];
  return `${d.sign}${e.points.toLocaleString("en-US")}`;
}

function entryTone(e: LedgerEntry): string {
  return ENTRY_DISPLAY[e.entryType].tone;
}
