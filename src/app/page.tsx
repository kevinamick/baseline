import { getAuthContext } from "@/lib/auth/context";
import Link from "next/link";
import Image from "next/image";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createCheckoutSession } from "@/app/actions/checkout";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { SignUpCta } from "@/app/_components/sign-up-cta";
import { SignInCta } from "@/app/_components/sign-in-cta";
import { CheckoutStatus } from "@/app/_components/checkout-status";
import { CheckIcon } from "@/app/_components/icons";
import { Suspense } from "react";

export default async function Home() {
  const { userId } = await getAuthContext();

  const { data: customer } = userId
    ? await supabaseAdmin
        .from("customers")
        .select("stripe_subscription_id, email")
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null };

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <Suspense>
        <CheckoutStatus />
      </Suspense>

      {/* Nav */}
      <header className="flex items-center gap-3 px-6 py-4">
        <span className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink">
          <Image src="/logo-mark.svg" width={20} height={20} alt="" priority />
          Baseline
        </span>
        <div className="flex-1" />
        {userId ? (
          <>
            <Link
              href="/dashboard"
              className="rounded-full px-3.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:text-ink"
            >
              Open Baseline
            </Link>
            <SignOutButton className="rounded-full border border-hairline-cool bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:text-ink" />
          </>
        ) : (
          <>
            <SignInCta className="rounded-full px-3.5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:text-ink">
              Sign in
            </SignInCta>
            <SignUpCta className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft">
              Get started free
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
              Measure agent quality{" "}
              <span className="inline-block rounded-xl bg-accent px-3.5 pb-1 text-ink">
                rigorously
              </span>
              .
            </h1>
            <p className="max-w-[460px] text-[17px] leading-normal text-zinc-700">
              Author rubrics, run them against your AI outputs, and ship with
              confidence. Every Eval Run is reproducible and shared across your
              team.
            </p>

            <div className="flex items-center gap-2.5">
              {userId ? (
                customer ? (
                  <>
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-800">
                      Subscribed ✓
                    </span>
                    <Link
                      href="/dashboard"
                      className="inline-flex items-center gap-1.5 rounded-full bg-ink px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-ink-soft"
                    >
                      Open Baseline →
                    </Link>
                  </>
                ) : (
                  <form action={createCheckoutSession}>
                    <button
                      type="submit"
                      className="inline-flex items-center rounded-full bg-ink px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-ink-soft"
                    >
                      Subscribe
                    </button>
                  </form>
                )
              ) : (
                <>
                  <SignUpCta className="inline-flex items-center rounded-full bg-ink px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-ink-soft">
                    Get started free
                  </SignUpCta>
                  <SignInCta className="inline-flex items-center gap-1.5 rounded-full px-4 py-3 text-sm font-medium text-zinc-700 transition-colors hover:text-ink">
                    Sign in →
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
    </div>
  );
}

// A white "latest run" preview — score + weighted criterion bars.
function ScorePreviewCard() {
  const criteria = [
    { name: "Empathy", score: 0.92, weight: 0.3 },
    { name: "Accuracy", score: 0.91, weight: 0.45 },
    { name: "Resolution", score: 0.83, weight: 0.25 },
  ];
  return (
    <div className="rounded-2xl border border-hairline-cool bg-white p-6 shadow-card">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="mb-1 text-[13px] text-zinc-500">Latest run</div>
          <div className="text-lg font-semibold tracking-[-0.01em] text-ink">
            Customer support quality
          </div>
        </div>
        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
          Completed
        </span>
      </div>
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-5xl font-bold tracking-[-0.025em] tabular-nums text-emerald-600">
          87%
        </span>
        <span className="text-[13px] text-zinc-500">
          weighted across 3 criteria, 24 rows
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {criteria.map((c) => (
          <div key={c.name} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-zinc-700">{c.name}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-warm">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.round(c.score * 100)}%` }}
              />
            </div>
            <span className="w-9 text-right font-mono text-xs font-bold tabular-nums text-emerald-600">
              {Math.round(c.score * 100)}%
            </span>
            <span className="w-12 text-right font-mono text-[11px] tabular-nums text-zinc-400">
              w {c.weight.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The dark "focus" card — one per view. Here: the agent self-improvement loop.
function ImprovingPreviewCard() {
  const tasks = [
    { label: "Generate 24 new test cases", done: true },
    { label: "Re-balance criterion weights", done: true },
    { label: "Tune empathy threshold", done: false },
    { label: "Re-evaluate against baseline", done: false },
  ];
  return (
    <div className="rounded-3xl bg-ink-soft p-6 text-white">
      <div className="mb-3.5 flex items-center justify-between">
        <div className="text-base font-semibold tracking-[-0.01em]">
          Now improving
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-semibold text-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-soft" />
          Running
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {tasks.map((t) => (
          <div key={t.label} className="flex items-center gap-3">
            <span
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-ink ${
                t.done ? "bg-accent" : "border-[1.5px] border-white/30"
              }`}
            >
              {t.done && <CheckIcon size={12} />}
            </span>
            <span
              className={`text-[13px] ${t.done ? "text-white/60 line-through" : "text-white"}`}
            >
              {t.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
