"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { readConsent, writeConsent, type ConsentChoice } from "@/lib/consent/cookie";

const CONSENT_EVENT = "baseline:consentchange";

/**
 * The cookie-consent gate. A dismissible card in the lower-left that asks the
 * visitor to accept or reject non-essential analytics (PostHog + Sentry).
 *
 * Analytics run by default (opt-out) — instrumentation-client.ts reads the same
 * cookie and only skips the SDKs once it reads "rejected". Because that gating
 * happens once at startup, rejecting reloads the page so the already-initialized
 * SDKs are torn down; accepting just records the choice and dismisses (analytics
 * are already running).
 *
 * The current choice is read from the cookie via useSyncExternalStore: the
 * server snapshot is always null (so SSR/hydration render nothing and never
 * mismatch), and a custom event re-reads the cookie after a choice is recorded.
 */
function subscribe(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_EVENT, onChange);
}

export function CookieConsent() {
  const choice = useSyncExternalStore<ConsentChoice | null>(
    subscribe,
    () => readConsent(),
    () => null,
  );

  if (choice !== null) return null;

  function decide(next: ConsentChoice) {
    writeConsent(next);
    window.dispatchEvent(new Event(CONSENT_EVENT));
    // Rejecting must tear down the analytics SDKs, which only gate at load.
    if (next === "rejected") location.reload();
  }

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="fixed bottom-4 left-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-hairline-cool bg-card p-5 shadow-card"
    >
      <p className="text-sm font-semibold tracking-[-0.01em] text-ink">
        We use cookies
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">
        Strictly-necessary cookies keep you signed in and are always on. We also
        use analytics cookies to understand product usage and diagnose errors —
        you can turn these off any time. See our{" "}
        <Link
          href="/privacy"
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Privacy &amp; Cookie Notice
        </Link>
        .
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => decide("rejected")}
          className="rounded-full px-4 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => decide("accepted")}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-fg-on-ink transition-colors hover:bg-ink-hover"
        >
          Accept
        </button>
      </div>
    </div>
  );
}
