import Link from "next/link";
import { getAuthContext } from "@/lib/auth/context";
import { getBillingState } from "@/lib/billing/state";
import { createCheckoutSession } from "@/app/actions/checkout";
import { BrandMark } from "@/app/_components/brand-mark";
import { CheckIcon } from "@/app/_components/icons";
import {
  ORDERED_PLANS,
  type PlanDefinition,
  type PlanSlug,
} from "@/lib/billing/plans";

export const metadata = {
  title: "Pricing — Baseline",
};

function retentionLabel(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return `${years} year${years > 1 ? "s" : ""}`;
  }
  return `${days} days`;
}

// The feature rows shown on every plan card, derived from the plan definition so
// no number is duplicated. Uses glossary vocabulary (Eval Points, Optimization
// Runs, Managed Keys) — never "GEPA".
function featureRows(plan: PlanDefinition): string[] {
  return [
    plan.seatLimit === null
      ? "Unlimited seats"
      : `${plan.seatLimit} seat${plan.seatLimit > 1 ? "s" : ""}`,
    `${plan.includedEvalPoints.toLocaleString()} Eval Points / month`,
    plan.includedOptimizationRuns > 0
      ? `${plan.includedOptimizationRuns} Optimization Runs / month`
      : "Optimization Runs not included",
    `${retentionLabel(plan.retentionDays)} of Run History`,
    plan.managedMarkupPct === null
      ? "Bring your own LLM key"
      : `Managed Keys at cost + ${plan.managedMarkupPct}%`,
    plan.evalPointOverageUsd === null
      ? "Hard stop at included usage"
      : "Opt-in overage available",
  ];
}

interface CtaContext {
  signedIn: boolean;
  canSubscribe: boolean;
  orgId: string | null;
  currentPlan: PlanSlug | null;
}

function PlanCta({ plan, ctx }: { plan: PlanDefinition; ctx: CtaContext }) {
  const base =
    "inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition-colors";
  const primary = `${base} bg-ink text-fg-on-ink hover:bg-ink-hover`;
  const muted = `${base} border border-hairline-cool bg-card text-fg-2`;

  if (ctx.currentPlan === plan.slug) {
    return <span className={`${muted} cursor-default`}>Current plan</span>;
  }

  // Free needs no checkout — it's the baseline every Team already has.
  if (plan.slug === "free") {
    return <span className={`${muted} cursor-default`}>Included</span>;
  }

  if (!ctx.signedIn) {
    return (
      <Link href="/sign-up" className={primary}>
        Get started
      </Link>
    );
  }

  if (!ctx.canSubscribe || !ctx.orgId) {
    // A Readonly Member (or a user with no Team) can't subscribe; the server
    // action enforces this too — this is just the matching UI affordance.
    return (
      <span className={`${muted} cursor-not-allowed`}>Contributors only</span>
    );
  }

  return (
    <form action={createCheckoutSession.bind(null, ctx.orgId, plan.slug)}>
      <button type="submit" className={primary}>
        Subscribe
      </button>
    </form>
  );
}

function PlanCard({ plan, ctx }: { plan: PlanDefinition; ctx: CtaContext }) {
  const highlighted = plan.slug === "builder";
  return (
    <div
      className={`flex flex-col rounded-3xl border p-6 ${
        highlighted
          ? "border-ink/15 bg-card shadow-card"
          : "border-hairline-cool bg-card"
      }`}
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
          {plan.name}
        </h2>
        {highlighted && (
          <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-fg-on-accent">
            Popular
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] text-fg-3">{plan.audience}</p>
      <div className="mb-5 flex items-baseline gap-1">
        <span className="font-mono text-4xl font-bold tracking-[-0.025em] tabular-nums text-ink">
          ${plan.monthlyPriceUsd}
        </span>
        <span className="text-[13px] text-fg-3">/ month</span>
      </div>
      <PlanCta plan={plan} ctx={ctx} />
      <ul className="mt-6 flex flex-col gap-2.5">
        {featureRows(plan).map((row) => (
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
  const rows = [
    "Unlimited seats with SAML / SSO",
    "Custom Eval Point & Optimization Run volumes",
    "Custom Run History retention",
    "Managed Keys at negotiated markup",
    "Dedicated SLA & support",
  ];
  return (
    <div className="flex flex-col rounded-3xl bg-ink-soft p-6 text-white">
      <h2 className="mb-1 text-lg font-semibold tracking-[-0.01em]">Enterprise</h2>
      <p className="mb-4 text-[13px] text-white/60">High-Volume Enterprises</p>
      <div className="mb-5 flex items-baseline gap-1">
        <span className="font-mono text-4xl font-bold tracking-[-0.025em] text-white">
          Custom
        </span>
      </div>
      {/* text-ink-soft, not text-ink: this card is hard-coded dark, and --ink
          flips near-white in dark mode (white-on-white); ink-soft stays dark
          in both themes. */}
      <a
        href="mailto:sales@baseline.dev?subject=Enterprise%20plan"
        className="inline-flex w-full items-center justify-center rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink-soft transition-colors hover:bg-white/90"
      >
        Contact sales
      </a>
      <ul className="mt-6 flex flex-col gap-2.5">
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

  const ctx: CtaContext = {
    signedIn: !!userId,
    canSubscribe: canWrite,
    orgId,
    // Only surface a "Current plan" badge to a signed-in Team member.
    currentPlan: userId ? billing.plan : null,
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
            Open Baseline
          </Link>
        )}
      </header>

      <main className="flex flex-1 flex-col items-center px-6 py-10">
        <div className="mb-10 text-center">
          <h1 className="text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-[-0.025em] text-ink">
            Pricing that scales with your evals
          </h1>
          <p className="mx-auto mt-3 max-w-[520px] text-[15px] text-fg-2">
            Every plan is per Team. Eval Points measure platform work; LLM token
            costs are always billed transparently or run on your own key.
          </p>
        </div>

        <div className="grid w-full max-w-6xl grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
          {ORDERED_PLANS.map((plan) => (
            <PlanCard key={plan.slug} plan={plan} ctx={ctx} />
          ))}
          <EnterpriseCard />
        </div>
      </main>
    </div>
  );
}
