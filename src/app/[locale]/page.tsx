import { headers } from "next/headers";
import { getAuthContext } from "@/lib/auth/context";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { BrandMark } from "@/app/_components/brand-mark";
import { JsonLd } from "@/app/_components/json-ld";
import { softwareApplicationSchema } from "@/lib/seo";
import { getBillingState } from "@/lib/billing/state";
import { SignUpCta } from "@/app/_components/sign-up-cta";
import { LandingNav } from "@/app/_components/landing-nav";
import { Reveal } from "@/app/_components/reveal";
import { HeroResultCard } from "@/app/_components/hero-result-card";
import { CheckoutStatus } from "@/app/_components/checkout-status";
import { SiteFooterLinks } from "@/app/_components/site-footer";
import {
  SparklesIcon,
  FileTextIcon,
  ActivityIcon,
  BarChart3Icon,
  UsersIcon,
  SearchIcon,
  AlertTriangleIcon,
  Loader2Icon,
  CheckIcon,
} from "@/app/_components/icons";
import { Suspense, type ComponentType } from "react";

/** Auth shape threaded into the conversion surfaces so signed-in visitors get
 *  "Open Baseline" instead of a sign-up wall. */
type Auth = { signedIn: boolean; canSubscribe: boolean };

export default async function Home() {
  const { userId, orgId, canWrite } = await getAuthContext();

  // Billing is Team-scoped (ADR-0007), read through the fail-closed resolver.
  // Only a Contributor of a Team that isn't already subscribed can subscribe it.
  const billing = await getBillingState(orgId);
  const auth: Auth = {
    signedIn: !!userId,
    canSubscribe: !!orgId && canWrite && !billing.active,
  };

  // Per-request CSP nonce (minted in proxy.ts) for the product structured data —
  // same source the root layout reads for the theme script. getAuthContext() above
  // already opted this page into dynamic rendering, so reading headers() is free.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div
      id="top"
      className="landing-root flex min-h-screen flex-col bg-paper bg-paper-gradient"
    >
      {/* Product structured data for rich results (#278), nonce'd like Organization. */}
      <JsonLd schema={softwareApplicationSchema()} nonce={nonce} />

      <Suspense>
        <CheckoutStatus />
      </Suspense>

      <LandingNav signedIn={auth.signedIn} canSubscribe={auth.canSubscribe} />

      <main className="flex-1">
        <Hero auth={auth} />
        <ProblemSection />
        <OptimizationSection />
        <FeaturesSection />
        <FinalCta auth={auth} />
      </main>

      <LandingFooter />
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

const SECTION = "mx-auto w-full max-w-[1180px] px-6";

// Keyboard focus ring — matches the app-wide convention (focus-visible cobalt
// ring). `FOCUS_LIGHT` is the variant for controls sitting on the dark ink-soft
// cards, where a cobalt ring would disappear.
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const FOCUS_LIGHT = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.15em] text-accent-ink">
      <span className="h-px w-[18px] bg-accent" aria-hidden="true" />
      {children}
    </div>
  );
}

// The page's primary conversion button — ink fill, label depends on auth.
function PrimaryCta({ auth, className }: { auth: Auth; className: string }) {
  const t = useTranslations("Home");
  if (!auth.signedIn) {
    return <SignUpCta className={className}>{t("getStartedFree")}</SignUpCta>;
  }
  return (
    <Link href="/dashboard" className={className}>
      {t("openBaseline")}
      <span aria-hidden="true"> →</span>
    </Link>
  );
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function Hero({ auth }: { auth: Auth }) {
  const t = useTranslations("Home");
  return (
    <section className={`${SECTION} grid grid-cols-1 items-center gap-8 pb-12 pt-[clamp(2rem,5vw,4rem)] lg:grid-cols-[1.05fr_0.95fr] lg:gap-[clamp(2rem,5vw,4rem)]`}>
      <Reveal className="flex flex-col gap-6">
        <Eyebrow>{t("heroEyebrow")}</Eyebrow>
        <h1 className="text-[clamp(2.5rem,5.6vw,4.75rem)] font-semibold leading-[1.0] tracking-[-0.032em] text-ink">
          {t.rich("heroTitle", {
            hl: (chunks) => (
              <span className="inline-block rounded-[18px] bg-accent px-3.5 pb-1 text-fg-on-accent">
                {chunks}
              </span>
            ),
          })}
        </h1>
        <p className="max-w-[52ch] text-[clamp(1rem,1.6vw,1.25rem)] leading-[1.55] text-fg-2">
          {t("heroSubtitle")}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <PrimaryCta
            auth={auth}
            className={`inline-flex items-center rounded-full bg-ink px-7 py-[15px] text-base font-medium text-fg-on-ink transition-colors hover:bg-ink-hover ${FOCUS}`}
          />
          <a
            href="#optimize"
            className={`inline-flex items-center rounded-full px-6 py-[15px] text-base font-medium text-fg-2 transition-colors hover:bg-card-warm hover:text-ink ${FOCUS}`}
          >
            {t("heroSeeOptimization")}
            <span aria-hidden="true"> →</span>
          </a>
        </div>

        <p className="text-[13.5px] text-fg-3">{t("heroReassurance")}</p>
      </Reveal>

      <Reveal delay={120}>
        <HeroResultCard />
        <div className="mx-auto mt-4 flex w-fit items-center gap-2 rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-[12.5px] text-fg-2 shadow-sm">
          <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success-fg">
            <CheckIcon size={11} />
            {t("runChipDone")}
          </span>
          {t("runChip")}
        </div>
      </Reveal>
    </section>
  );
}

// ── Problem ──────────────────────────────────────────────────────────────────

function ProblemSection() {
  const t = useTranslations("Home");
  const pains = [
    { title: t("pain1Title"), body: t("pain1Body") },
    { title: t("pain2Title"), body: t("pain2Body") },
    { title: t("pain3Title"), body: t("pain3Body") },
  ];
  return (
    <section id="problem" className={`${SECTION} scroll-mt-24 py-[clamp(2.5rem,6vw,4.75rem)]`}>
      <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-[clamp(1.75rem,5vw,4.5rem)]">
        <Reveal className="flex flex-col gap-5">
          <Eyebrow>{t("problemEyebrow")}</Eyebrow>
          <h2 className="text-[clamp(1.875rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.025em] text-ink">
            {t("problemTitle")}
          </h2>
          <p className="max-w-[48ch] text-[17px] leading-[1.55] text-fg-2">
            {t("problemLead")}
          </p>
          <div className="mt-1 flex flex-col gap-3">
            {pains.map((p) => (
              <div
                key={p.title}
                className="flex items-start gap-3.5 rounded-lg border border-hairline-cool bg-card p-4 shadow-sm"
              >
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md bg-warning-bg text-warning-fg">
                  <AlertTriangleIcon size={16} />
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-ink">{p.title}</div>
                  <div className="mt-0.5 text-sm leading-normal text-fg-2">{p.body}</div>
                </div>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={120}>
          <GuessingLoopCard />
        </Reveal>
      </div>
    </section>
  );
}

function GuessingLoopCard() {
  const t = useTranslations("Home");
  const steps = [
    { n: "01", label: t("loopStep1") },
    { n: "02", label: t("loopStep2") },
    { n: "03", label: t("loopStep3") },
    { n: "04", label: t("loopStep4"), danger: true },
  ];
  return (
    <div className="rounded-3xl border border-hairline-cool bg-card p-7 shadow-lg">
      <div className="mb-5 flex items-center gap-2.5 text-[15px] font-semibold text-ink">
        <Loader2Icon size={18} className="text-fg-3" />
        {t("loopTitle")}
      </div>
      <div className="flex flex-col gap-2.5">
        {steps.map((s) => (
          <div
            key={s.n}
            className={`flex items-center gap-3 rounded-lg border border-dashed px-3.5 py-3 ${
              s.danger
                ? "border-danger bg-danger-bg text-danger-fg"
                : "border-hairline-strong bg-row text-fg-2"
            }`}
          >
            <span
              className={`font-mono text-xs font-bold tabular-nums ${
                s.danger ? "text-danger-fg" : "text-fg-4"
              }`}
            >
              {s.n}
            </span>
            <span className="text-sm">{s.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 text-center text-[13px] text-fg-3">
        <span aria-hidden="true">↻ </span>
        {t("loopFootnote")}
      </div>
    </div>
  );
}

// ── Optimization (centerpiece) ───────────────────────────────────────────────

function OptimizationSection() {
  const t = useTranslations("Home");
  const steps = [
    { title: t("step1Title"), body: t("step1Body") },
    { title: t("step2Title"), body: t("step2Body") },
    { title: t("step3Title"), body: t("step3Body") },
    { title: t("step4Title"), body: t("step4Body") },
  ];
  return (
    <section
      id="optimize"
      className="scroll-mt-24 border-y border-hairline-cool bg-paper-soft py-[clamp(3.5rem,9vw,7.25rem)]"
    >
      <div className={SECTION}>
        <Reveal className="mx-auto flex max-w-[640px] flex-col items-center gap-4 text-center">
          <Eyebrow>{t("optEyebrow")}</Eyebrow>
          <h2 className="text-[clamp(1.875rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.025em] text-ink">
            {t("optTitle")}
          </h2>
          <p className="text-[17px] leading-[1.55] text-fg-2">{t("optLead")}</p>
          <blockquote className="mt-1 w-full rounded-lg border-l-[3px] border-accent bg-accent-soft px-5 py-3.5 text-left text-[17px] font-medium text-accent-ink">
            {t("optQuote")}
          </blockquote>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 items-start gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:gap-[clamp(2rem,5vw,4rem)]">
          <Reveal className="flex flex-col gap-6">
            {steps.map((s, i) => (
              <div key={s.title} className="flex items-start gap-4">
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[13px] font-bold tabular-nums text-accent-ink">
                  {i + 1}
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-ink">{s.title}</div>
                  <div className="mt-1 text-sm leading-normal text-fg-2">{s.body}</div>
                </div>
              </div>
            ))}
          </Reveal>

          <Reveal delay={120}>
            <OptimizationFocusCard />
          </Reveal>
        </div>

        <Reveal className="mt-10 flex justify-center">
          <p className="flex items-center gap-2 rounded-full border border-hairline-cool bg-card px-5 py-3 text-center text-[13.5px] text-fg-2 shadow-sm">
            <SparklesIcon size={16} className="shrink-0 text-accent" />
            {t("optNote")}
          </p>
        </Reveal>
      </div>
    </section>
  );
}

// The dark "Optimization Run" focus card — the one dark surface on the light page.
function OptimizationFocusCard() {
  const t = useTranslations("Home");
  const tasks = [
    { label: t("ftask1"), done: true },
    { label: t("ftask2"), done: true },
    { label: t("ftask3"), done: false },
  ];
  return (
    <div className="hero-card rounded-3xl bg-ink-soft p-[30px] text-white shadow-xl">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <div className="text-[17px] font-semibold tracking-[-0.01em]">
            {t("focusTitle")}
          </div>
          <div className="mt-0.5 text-[13px] text-fg-on-ink-muted">{t("focusSub")}</div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-blue-300">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse-soft motion-reduce:animate-none" />
          {t("focusRunning")}
        </span>
      </div>

      <div className="flex items-end gap-3 border-b border-white/10 pb-5">
        <span className="font-mono text-[26px] font-medium tabular-nums text-fg-on-ink-muted line-through">
          61%
        </span>
        <span className="pb-1.5 text-white/40">→</span>
        <span className="font-mono text-[46px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#5EE0A0]">
          94%
        </span>
        <span className="pb-1.5 text-[13px] text-fg-on-ink-muted">
          {t("focusResultQuality")}
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-3">
        {tasks.map((task) => (
          <div key={task.label} className="flex items-center gap-3">
            <span
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full ${
                task.done ? "bg-accent text-fg-on-accent" : "border-[1.5px] border-white/30"
              }`}
            >
              {task.done && <CheckIcon size={12} />}
            </span>
            <span
              className={`text-[13px] ${task.done ? "text-white/55 line-through" : "text-white"}`}
            >
              {task.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Feature grid ─────────────────────────────────────────────────────────────

function FeaturesSection() {
  const t = useTranslations("Home");
  const features: {
    term: string;
    title: string;
    body: string;
    Icon: ComponentType<{ size?: number; className?: string }>;
    star?: boolean;
  }[] = [
    { term: t("feature1Term"), title: t("feature1Title"), body: t("feature1Body"), Icon: SparklesIcon, star: true },
    { term: t("feature2Term"), title: t("feature2Title"), body: t("feature2Body"), Icon: FileTextIcon },
    { term: t("feature3Term"), title: t("feature3Title"), body: t("feature3Body"), Icon: ActivityIcon },
    { term: t("feature4Term"), title: t("feature4Title"), body: t("feature4Body"), Icon: BarChart3Icon },
    { term: t("feature5Term"), title: t("feature5Title"), body: t("feature5Body"), Icon: UsersIcon },
    { term: t("feature6Term"), title: t("feature6Title"), body: t("feature6Body"), Icon: SearchIcon },
  ];
  return (
    <section id="features" className={`${SECTION} scroll-mt-24 py-[clamp(3.5rem,9vw,7rem)]`}>
      <Reveal className="flex max-w-[640px] flex-col gap-4">
        <Eyebrow>{t("featEyebrow")}</Eyebrow>
        <h2 className="text-[clamp(1.875rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.025em] text-ink">
          {t("featTitle")}
        </h2>
        <p className="text-[17px] leading-[1.55] text-fg-2">{t("featLead")}</p>
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <Reveal key={f.title} delay={(i % 3) * 80}>
            <div className="group h-full rounded-xl border border-hairline-cool bg-card p-[26px] shadow-card transition-all duration-150 hover:-translate-y-[3px] hover:border-hairline-strong hover:shadow-lg">
              <span
                className={`mb-4 flex h-[42px] w-[42px] items-center justify-center rounded-xl ${
                  f.star ? "bg-accent text-fg-on-accent" : "bg-accent-soft text-accent-ink"
                }`}
              >
                <f.Icon size={20} />
              </span>
              <div className="mb-2.5 inline-flex rounded-full bg-accent-soft px-2.5 py-0.5 font-mono text-[11px] font-medium text-accent-ink">
                {f.term}
              </div>
              <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
                {f.title}
              </h3>
              <p className="mt-1.5 text-sm leading-normal text-fg-2">{f.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ── Final CTA ────────────────────────────────────────────────────────────────

function FinalCta({ auth }: { auth: Auth }) {
  const t = useTranslations("Home");
  return (
    <section className={`${SECTION} pb-[clamp(3.5rem,9vw,7rem)]`}>
      <Reveal>
        <div className="hero-card flex flex-col items-center gap-5 rounded-3xl bg-ink-soft px-6 py-[clamp(3rem,7vw,5rem)] text-center text-white shadow-xl">
          <h2 className="max-w-[20ch] text-[clamp(1.875rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.025em]">
            {t("ctaTitle")}
          </h2>
          <p className="max-w-[52ch] text-[17px] leading-[1.55] text-fg-on-ink-muted">
            {t("ctaSubtitle")}
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
            <PrimaryCta
              auth={auth}
              className={`inline-flex items-center rounded-full bg-white px-7 py-[15px] text-base font-medium text-ink-soft transition-colors hover:bg-white/90 ${FOCUS_LIGHT}`}
            />
            {auth.canSubscribe || !auth.signedIn ? (
              <Link
                href="/pricing"
                className={`inline-flex items-center rounded-full border border-white/20 px-6 py-[15px] text-base font-medium text-white transition-colors hover:bg-white/10 ${FOCUS_LIGHT}`}
              >
                {t("ctaViewPricing")}
              </Link>
            ) : null}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────

// One <footer> landmark: the landing-specific brand + product-nav block, then the
// legal bottom bar. The bar's content comes from the shared <SiteFooterLinks/> so
// those compliance links stay identical to /pricing and /privacy (one source, no
// drift), while the landing keeps its own left-aligned, bordered placement.
function LandingFooter() {
  const t = useTranslations("Home");
  return (
    <footer className="border-t border-hairline-cool">
      <div className={`${SECTION} py-12`}>
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[36ch]">
            <div className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em] text-ink">
              <BrandMark size={22} />
              Baseline
            </div>
            <p className="mt-3 text-sm leading-normal text-fg-3">{t("footerTagline")}</p>
          </div>

          <nav className="flex flex-col items-start gap-2.5">
            <div className="text-xs font-semibold uppercase tracking-[0.15em] text-fg-3">
              {t("footerProduct")}
            </div>
            <a
              href="#optimize"
              className={`rounded-sm text-sm text-fg-2 transition-colors hover:text-ink ${FOCUS}`}
            >
              {t("navOptimization")}
            </a>
            <a
              href="#features"
              className={`rounded-sm text-sm text-fg-2 transition-colors hover:text-ink ${FOCUS}`}
            >
              {t("navFeatures")}
            </a>
            <Link
              href="/pricing"
              className={`rounded-sm text-sm text-fg-2 transition-colors hover:text-ink ${FOCUS}`}
            >
              {t("footerPricing")}
            </Link>
            <Link
              href="/docs"
              className={`rounded-sm text-sm text-fg-2 transition-colors hover:text-ink ${FOCUS}`}
            >
              {t("navDocs")}
            </Link>
          </nav>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline-cool pt-6 text-xs text-fg-3">
          <SiteFooterLinks />
        </div>
      </div>
    </footer>
  );
}
