import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { getBillingState } from "@/lib/billing/state";
import { BrandMark } from "@/app/_components/brand-mark";
import { CheckIcon } from "@/app/_components/icons";
import { SiteFooter } from "@/app/_components/site-footer";
import { buildAlternates } from "@/i18n/metadata";
import { defaultOpenGraph, defaultTwitter } from "@/lib/seo";
import {
  ORDERED_PLANS,
  PLANS,
  isPaidPlanSlug,
  type PlanDefinition,
  type PlanSlug,
} from "@/lib/billing/plans";
import { getPendingAccessCodeBenefitView } from "@/lib/access-codes/pending-benefit";
import { CheckoutCta } from "./_components/checkout-cta";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });
  const title = t("pricingTitle");
  const description = t("pricingDescription");
  return {
    title,
    description,
    alternates: buildAlternates(locale, "/pricing"),
    openGraph: defaultOpenGraph(locale, "/pricing", title, description),
    twitter: defaultTwitter(title, description),
  };
}

// The feature rows shown on every plan card, derived from the plan definition so
// no number is duplicated. Uses glossary vocabulary (Eval Points, Optimization
// Runs, Managed Keys) — never "GEPA". Pluralization/number formatting is ICU,
// so each locale renders its own grammar.
function useFeatureRows(plan: PlanDefinition): string[] {
  const t = useTranslations("Pricing.feature");
  const retention =
    plan.retentionDays % 365 === 0
      ? t("retentionYears", { count: plan.retentionDays / 365 })
      : t("retentionDays", { count: plan.retentionDays });

  return [
    plan.seatLimit === null
      ? t("unlimitedSeats")
      : t("seats", { count: plan.seatLimit }),
    t("evalPoints", { count: plan.includedEvalPoints }),
    // A lifetime grant (Free's one run) is a one-time count, not "/ month".
    plan.optimizationRunsGrant === "lifetime" && plan.includedOptimizationRuns > 0
      ? t("optimizationRunsLifetime", { count: plan.includedOptimizationRuns })
      : t("optimizationRuns", { count: plan.includedOptimizationRuns }),
    retention,
    plan.managedMarkupPct === null
      ? t("byoKey")
      : t("managedKeys", { pct: plan.managedMarkupPct }),
    plan.evalPointOverageUsd === null ? t("hardStop") : t("overage"),
  ];
}

interface CtaContext {
  signedIn: boolean;
  canSubscribe: boolean;
  orgId: string | null;
  currentPlan: PlanSlug | null;
  /**
   * The plan a pending Access Code benefit is restricted to (ADR-0017 slice
   * 4, #428) — null when there's no pending benefit, or it applies to any
   * plan. Drives the pre-checkout forfeit warning on every OTHER paid plan's
   * card; never blocks the purchase itself.
   */
  benefitRestrictedToPlan: PlanSlug | null;
}

function PlanCta({ plan, ctx }: { plan: PlanDefinition; ctx: CtaContext }) {
  const t = useTranslations("Pricing");
  const base =
    "inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition-colors";
  const primary = `${base} bg-ink text-fg-on-ink hover:bg-ink-hover`;
  const muted = `${base} border border-hairline-cool bg-card text-fg-2`;

  if (ctx.currentPlan === plan.slug) {
    return <span className={`${muted} cursor-default`}>{t("currentPlan")}</span>;
  }

  // Free needs no checkout — it's the baseline every Team already has.
  if (plan.slug === "free") {
    return <span className={`${muted} cursor-default`}>{t("included")}</span>;
  }

  if (!ctx.signedIn) {
    return (
      <Link href="/sign-up" className={primary}>
        {t("getStarted")}
      </Link>
    );
  }

  if (!ctx.canSubscribe || !ctx.orgId) {
    // A Readonly Member (or a user with no Team) can't subscribe; the server
    // action enforces this too — this is just the matching UI affordance.
    return (
      <span className={`${muted} cursor-not-allowed`}>
        {t("contributorsOnly")}
      </span>
    );
  }

  if (!isPaidPlanSlug(plan.slug)) {
    // Unreachable in practice (Free/Enterprise never reach here), but keeps
    // the checkout call below typed to PaidPlanSlug without a cast.
    return null;
  }

  const mismatched =
    ctx.benefitRestrictedToPlan != null &&
    ctx.benefitRestrictedToPlan !== plan.slug;

  return (
    <CheckoutCta
      orgId={ctx.orgId}
      planSlug={plan.slug}
      planName={plan.name}
      label={t("subscribe")}
      className={primary}
      mismatchedBenefitPlanName={
        mismatched ? PLANS[ctx.benefitRestrictedToPlan!].name : null
      }
    />
  );
}

// Distinct accent borders with progressive visual weight (issue #350):
// Builder gets a subtle ink hairline + shadow (the "popular" entry tier),
// Scale gets a medium cobalt accent border, and Enterprise gets the strongest
// accent ring (it's on a dark surface, so the ring is brighter).
function cardBorderClass(slug: PlanSlug | "enterprise"): string {
  switch (slug) {
    case "free":
      return "border border-hairline-cool bg-card";
    case "builder":
      return "border border-ink/15 bg-card shadow-card";
    case "scale":
      return "border-2 border-accent/30 bg-card shadow-card";
    case "enterprise":
      return "border-2 border-accent/50 bg-ink-soft shadow-card";
    default:
      return "border border-hairline-cool bg-card";
  }
}

function PlanCard({ plan, ctx }: { plan: PlanDefinition; ctx: CtaContext }) {
  const t = useTranslations("Pricing");
  const rows = useFeatureRows(plan);
  return (
    <div
      className={`flex flex-col rounded-3xl p-5 ${cardBorderClass(plan.slug)}`}
    >
      <div className="mb-1 flex items-center justify-between">
        {/* Plan tier names stay English proper nouns (ADR-0011). */}
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
          {plan.name}
        </h2>
        {plan.slug === "builder" && (
          <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-fg-on-accent">
            {t("popular")}
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] text-fg-3">{t(`audience.${plan.slug}`)}</p>
      <div className="mb-5 flex items-baseline gap-1 min-h-[2.5rem]">
        <span className="font-mono text-4xl font-bold tracking-[-0.025em] tabular-nums text-ink">
          ${plan.monthlyPriceUsd}
        </span>
        <span className="text-[13px] text-fg-3">{t("perMonth")}</span>
      </div>
      <PlanCta plan={plan} ctx={ctx} />
      <ul className="mt-5 flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row} className="flex items-start gap-2.5 text-[13px] text-fg-2">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
              <CheckIcon size={11} />
            </span>
            {row}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Enterprise is sales-led (issue #137): a contact link, no self-serve path.
function EnterpriseCard() {
  const t = useTranslations("Pricing");
  const rows = [
    t("enterprise.seats"),
    t("enterprise.volumes"),
    t("enterprise.retention"),
    t("enterprise.managedKeys"),
    t("enterprise.support"),
  ];
  return (
    <div className={`flex flex-col rounded-3xl p-5 text-white ${cardBorderClass("enterprise")}`}>
      <h2 className="mb-1 text-lg font-semibold tracking-[-0.01em]">
        {t("enterpriseName")}
      </h2>
      <p className="mb-4 text-[13px] text-white/60">{t("audience.enterprise")}</p>
      {/* Same min-height as the numeric plan price so the CTA aligns on the
          same horizontal baseline across all cards (issue #350). The word
          stays text-2xl so longer locales (es "Personalizado", fr
          "Personnalisé") wrap inside the card. */}
      <div className="mb-5 flex items-baseline gap-1 min-h-[2.5rem]">
        <span className="font-mono text-2xl font-bold tracking-[-0.025em] text-white break-words leading-tight">
          {t("custom")}
        </span>
      </div>
      {/* text-ink-soft, not text-ink: this card is hard-coded dark, and --ink
          flips near-white in dark mode (white-on-white); ink-soft stays dark
          in both themes. */}
      <a
        href="mailto:sales@baseline.dev?subject=Enterprise%20plan"
        className="inline-flex w-full items-center justify-center rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink-soft transition-colors hover:bg-white/90"
      >
        {t("contactSales")}
      </a>
      <ul className="mt-5 flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row} className="flex items-start gap-2.5 text-[13px] text-white/80">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/15 text-white">
              <CheckIcon size={11} />
            </span>
            {row}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function PricingPage() {
  const { userId, orgId, canWrite } = await getAuthContext();
  const billing = await getBillingState(orgId);
  const t = await getTranslations("Pricing");
  // The mismatch warning (ADR-0017 slice 4, #428) needs only the pending
  // benefit's plan restriction, not its full trial/coupon shape — a
  // read-only lookup, same as the billing page's notice, so visiting this
  // page never consumes the grant.
  const pendingBenefit = orgId
    ? await getPendingAccessCodeBenefitView(orgId)
    : null;

  const ctx: CtaContext = {
    signedIn: !!userId,
    canSubscribe: canWrite,
    orgId,
    // Only surface a "Current plan" badge to a signed-in Team member.
    currentPlan: userId ? billing.plan : null,
    benefitRestrictedToPlan: pendingBenefit?.planSlug ?? null,
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex items-center gap-3 px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink"
        >
          <BrandMark size={20} />
          Baseline
        </Link>
        <div className="flex-1" />
        {userId && (
          <Link
            href="/dashboard"
            className="rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink"
          >
            {t("openBaseline")}
          </Link>
        )}
      </header>

      <main className="flex flex-1 flex-col items-center px-6 py-6">
        <div className="mb-6 text-center">
          <h1 className="text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-[-0.025em] text-ink">
            {t("title")}
          </h1>
          <p className="mx-auto mt-3 max-w-[600px] text-[15px] text-fg-2">
            {t("subtitle")}
          </p>
        </div>

        {/* #449: a pending Access Code trial benefit is the only way a
              checkout from this page can start a trial — plainly state, before
              Subscribe is ever clicked, that the trial waives the subscription
              fee only and managed-key usage still bills to the card. Never a
              tooltip: always-visible text right above the plan cards. */}
        {pendingBenefit?.trialDays != null && (
          <div
            data-testid="pricing-trial-disclosure"
            className="mx-auto mb-6 max-w-2xl rounded-2xl border border-accent bg-card px-5 py-4 text-center"
          >
            <p className="text-sm font-medium text-ink">
              {t("trialDisclosure.heading", { days: pendingBenefit.trialDays })}
            </p>
            <p className="mt-1 text-[13px] text-fg-2">
              {t("trialDisclosure.message")}
            </p>
          </div>
        )}

        <div className="grid w-full max-w-6xl grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
          {ORDERED_PLANS.map((plan) => (
            <PlanCard key={plan.slug} plan={plan} ctx={ctx} />
          ))}
          <EnterpriseCard />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
