import { getAuthContext } from "@/lib/auth/context";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { BrandMark } from "@/app/_components/brand-mark";
import { getBillingState } from "@/lib/billing/state";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { SignUpCta } from "@/app/_components/sign-up-cta";
import { SignInCta } from "@/app/_components/sign-in-cta";
import { CheckoutStatus } from "@/app/_components/checkout-status";
import { CheckIcon } from "@/app/_components/icons";
import { SiteFooter } from "@/app/_components/site-footer";
import { LocaleSwitcher } from "@/app/_components/locale-switcher";
import { Suspense } from "react";

export default async function Home() {
  const { userId, orgId, canWrite } = await getAuthContext();
  const t = await getTranslations("Home");
  const tn = await getTranslations("Nav");

  // Billing is Team-scoped (ADR-0007) and read through the fail-closed resolver,
  // never the live Stripe API. Only a Contributor of a Team can subscribe it.
  const billing = await getBillingState(orgId);
  const canSubscribe = !!orgId && canWrite && !billing.active;

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <Suspense>
        <CheckoutStatus />
      </Suspense>

      {/* Nav */}
      <header className="flex items-center gap-3 px-6 py-4">
        <span className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink">
          <BrandMark size={20} />
          Baseline
        </span>
        <div className="flex-1" />
        <LocaleSwitcher className="rounded-full border border-hairline-cool bg-card px-3 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink" />
        {/* Pricing is a marketing surface — shown to anyone not on an active
            premium plan (signed-out visitors and signed-in unsubscribed users
            alike), hidden once they're subscribed. Cobalt fill so it pops out
            of the nav without competing with the ink CTA. */}
        {!billing.active && (
          <Link
            href="/pricing"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-fg-on-accent transition-colors hover:bg-accent-hover"
          >
            {tn("pricing")}
          </Link>
        )}
        {userId ? (
          <>
            <Link
              href="/dashboard"
              className="rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink"
            >
              {tn("openBaseline")}
            </Link>
            <SignOutButton className="rounded-full border border-hairline-cool bg-card px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink" />
          </>
        ) : (
          <>
            {/* Bordered pill (mirrors SignOutButton) so it doesn't float as bare
                text between the cobalt Pricing pill and the ink CTA. */}
            <SignInCta className="rounded-full border border-hairline-cool bg-card px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink">
              {tn("signIn")}
            </SignInCta>
            <SignUpCta className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover">
              {tn("getStartedFree")}
            </SignUpCta>
          </>
        )}
      </header>

      {/* Hero */}
      <div className="flex flex-1 items-center justify-center px-6 py-6">
        <div className="grid w-full max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Copy */}
          <div className="flex flex-col gap-5 px-2 py-6">
            <h1 className="text-[clamp(2.75rem,5.5vw,4.25rem)] font-semibold leading-[1.0] tracking-[-0.025em] text-ink">
              {t.rich("heroTitle", {
                hl: (chunks: React.ReactNode) => (
                  <span className="inline-block rounded-xl bg-accent px-3.5 pb-1 text-fg-on-accent">
                    {chunks}
                  </span>
                ),
              })}
            </h1>
            <p className="max-w-[460px] text-[17px] leading-normal text-fg-2">
              {t("heroSubtitle")}
            </p>

            <div className="flex items-center gap-2.5">
              {userId ? (
                billing.active ? (
                  <>
                    <span className="inline-flex items-center rounded-full bg-success-bg px-5 py-3 text-sm font-medium text-success-fg">
                      {t("subscribed")}
                    </span>
                    <Link
                      href="/dashboard"
                      className="inline-flex items-center gap-1.5 rounded-full bg-ink px-5 py-3 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
                    >
                      {t("openBaseline")}
                    </Link>
                  </>
                ) : canSubscribe ? (
                  <Link
                    href="/pricing"
                    className="inline-flex items-center rounded-full bg-ink px-5 py-3 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
                  >
                    {t("viewPlans")}
                  </Link>
                ) : (
                  <Link
                    href="/dashboard"
                    className="inline-flex items-center gap-1.5 rounded-full bg-ink px-5 py-3 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
                  >
                    {t("openBaseline")}
                  </Link>
                )
              ) : (
                <>
                  <SignUpCta className="inline-flex items-center rounded-full bg-ink px-5 py-3 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover">
                    {t("getStartedFree")}
                  </SignUpCta>
                  <SignInCta className="inline-flex items-center gap-1.5 rounded-full px-4 py-3 text-sm font-medium text-fg-2 transition-colors hover:text-ink">
                    {t("signIn")}
                  </SignInCta>
                </>
              )}
            </div>
          </div>

          {/* Preview card stack */}
          <div className="flex flex-col gap-4">
            <ScorePreviewCard />
            <ImprovingPreviewCard />
          </div>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}

// A white "latest run" preview — score + weighted criterion bars.
function ScorePreviewCard() {
  const t = useTranslations("Home");
  const criteria = [
    { name: t("criterionEmpathy"), score: 0.92, weight: 0.3 },
    { name: t("criterionAccuracy"), score: 0.91, weight: 0.45 },
    { name: t("criterionResolution"), score: 0.83, weight: 0.25 },
  ];
  return (
    <div className="rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="mb-1 text-[13px] text-fg-3">{t("previewLatestRun")}</div>
          <div className="text-lg font-semibold tracking-[-0.01em] text-ink">
            {t("previewRunName")}
          </div>
        </div>
        <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-[11px] font-semibold text-success-fg">
          {t("previewCompleted")}
        </span>
      </div>
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-5xl font-bold tracking-[-0.025em] tabular-nums text-success-fg">
          87%
        </span>
        <span className="text-[13px] text-fg-3">
          {t("previewScoreCaption", { criteria: 3, rows: 24 })}
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {criteria.map((c) => (
          <div key={c.name} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-fg-2">{c.name}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-warm">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.round(c.score * 100)}%` }}
              />
            </div>
            <span className="w-9 text-right font-mono text-xs font-bold tabular-nums text-success-fg">
              {Math.round(c.score * 100)}%
            </span>
            <span className="w-12 text-right font-mono text-[11px] tabular-nums text-fg-3">
              {t("previewWeight", { weight: c.weight.toFixed(2) })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The dark "focus" card — one per view. Here: the agent self-improvement loop.
function ImprovingPreviewCard() {
  const t = useTranslations("Home");
  const tasks = [
    { label: t("task1"), done: true },
    { label: t("task2"), done: true },
    { label: t("task3"), done: false },
    { label: t("task4"), done: false },
  ];
  return (
    <div className="hero-card rounded-3xl bg-ink-soft p-6 text-white">
      <div className="mb-3.5 flex items-center justify-between">
        <div className="text-base font-semibold tracking-[-0.01em]">
          {t("improvingTitle")}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-semibold text-blue-400">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse-soft" />
          {t("improvingRunning")}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {tasks.map((task) => (
          <div key={task.label} className="flex items-center gap-3">
            <span
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-fg-on-accent ${
                task.done ? "bg-accent" : "border-[1.5px] border-white/30"
              }`}
            >
              {task.done && <CheckIcon size={12} />}
            </span>
            <span
              className={`text-[13px] ${task.done ? "text-white/60 line-through" : "text-white"}`}
            >
              {task.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
