"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { readConsent, writeConsent, type ConsentChoice } from "@/lib/consent/cookie";

const CONSENT_EVENT = "baseline:consentchange";

/**
 * The cookie-consent gate. A dismissible card in the lower-left that asks the
 * visitor to accept or reject non-essential analytics (PostHog + Sentry).
 *
 * Nothing analytics-related runs until "Accept" is chosen — instrumentation-
 * client.ts reads the same cookie and only initializes the SDKs when it reads
 * "accepted". Because that gating happens once at startup, accepting reloads the
 * page so the SDKs come online immediately; rejecting just records the choice
 * and dismisses (there is nothing to tear down).
 *
 * The current choice is read from the cookie via useSyncExternalStore. The
 * server (and the first hydration pass) report "pending" — we can't read the
 * cookie until we're in the browser — and only the *client* snapshot resolves
 * to a real choice or "none". The banner renders solely for "none", so a
 * returning visitor who already chose never sees it flash in on refresh; the
 * cookie is read before the banner can paint. A custom event re-reads the
 * cookie after a choice is recorded.
 */
type ConsentView = ConsentChoice | "none" | "pending";

function subscribe(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_EVENT, onChange);
}

export function CookieConsent() {
  const view = useSyncExternalStore<ConsentView>(
    subscribe,
    () => readConsent() ?? "none",
    () => "pending",
  );

  if (view !== "none") return null;

  function decide(next: ConsentChoice) {
    writeConsent(next);
    window.dispatchEvent(new Event(CONSENT_EVENT));
    // Accepting must bring the analytics SDKs online; they only gate at load.
    if (next === "accepted") location.reload();
  }

  return (
    // A non-modal notice, not a dialog: the page stays fully usable behind it
    // and focus isn't trapped. role="region" + a label keeps it out of the
    // dialog accessibility tree (and out of test `getByRole("dialog")` queries).
    <section
      aria-label="Cookie consent"
      className="fixed bottom-4 left-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-hairline-cool bg-card p-5 shadow-card"
    >
      <p className="text-sm font-semibold tracking-[-0.01em] text-ink">
        We use cookies
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">
        Strictly-necessary cookies keep you signed in and are always on. With
        your consent we also use analytics cookies to understand product usage
        and diagnose errors. See our{" "}
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
    </section>
  );
}
