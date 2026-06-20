"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { readConsent, writeConsent, type ConsentChoice } from "@/lib/consent/cookie";
import { XIcon } from "@/app/_components/icons";

const CONSENT_EVENT = "baseline:consentchange";
const MANAGE_EVENT = "baseline:consentmanage";

/**
 * Re-open the consent banner so a visitor can revisit a prior choice (#67).
 * Wired to the "Cookie preferences" controls in the footer and privacy page.
 */
export function openConsentManager() {
  window.dispatchEvent(new Event(MANAGE_EVENT));
}

/**
 * The cookie-consent gate. A non-modal card in the lower-left that asks the
 * visitor to accept or reject non-essential analytics (PostHog).
 *
 * Nothing analytics-related runs until "Accept" is chosen — instrumentation-
 * client.ts reads the same cookie and only initializes PostHog when it reads
 * "accepted". Because that gating happens once at startup, changing whether
 * analytics may run reloads the page (to bring PostHog online, or tear it
 * down); a no-op re-confirmation just closes.
 *
 * It shows automatically until a first choice is made, and can be re-opened any
 * time via openConsentManager() so the choice stays revisitable.
 *
 * The current choice is read from the cookie via useSyncExternalStore. The
 * server (and the first hydration pass) report "pending" — we can't read the
 * cookie until we're in the browser — so the banner never renders server-side
 * and a returning visitor who already chose doesn't see it flash in on refresh.
 */
type ConsentView = ConsentChoice | "none" | "pending";

function subscribe(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_EVENT, onChange);
}

export function CookieConsent() {
  const t = useTranslations("CookieConsent");
  const view = useSyncExternalStore<ConsentView>(
    subscribe,
    () => readConsent() ?? "none",
    () => "pending",
  );

  // Re-opened on demand from a "Cookie preferences" control. Kept in local state
  // (not the cookie) so it only affects this tab/session.
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    const open = () => setManaging(true);
    window.addEventListener(MANAGE_EVENT, open);
    return () => window.removeEventListener(MANAGE_EVENT, open);
  }, []);

  // Auto-show until a first choice exists; otherwise only when explicitly
  // re-opened. "pending" (server/first hydration) shows nothing.
  const firstRun = view === "none";
  if (!firstRun && !managing) return null;

  const currentChoice: ConsentChoice | null =
    view === "accepted" || view === "rejected" ? view : null;

  function decide(next: ConsentChoice) {
    const wasOn = readConsent() === "accepted";
    writeConsent(next);
    window.dispatchEvent(new Event(CONSENT_EVENT));
    setManaging(false);
    // Reload only when analytics actually toggles on or off — otherwise the
    // SDKs' init state already matches the new choice and a reload is wasteful.
    if (wasOn !== (next === "accepted")) location.reload();
  }

  return (
    // A non-modal notice, not a dialog: the page stays fully usable behind it
    // and focus isn't trapped. role="region" + a label keeps it out of the
    // dialog accessibility tree (and out of test `getByRole("dialog")` queries).
    <section
      aria-label={t("region")}
      className="fixed bottom-4 left-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-hairline-cool bg-card p-5 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold tracking-[-0.01em] text-ink">
          {firstRun ? t("titleFirstRun") : t("titleManage")}
        </p>
        {/* Only offer a dismiss-without-choosing when re-opened: a prior choice
            already exists to fall back to. On first run we want an explicit
            accept/reject. */}
        {!firstRun && (
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setManaging(false)}
            className="-mr-1 -mt-1 rounded-full p-1 text-fg-3 transition-colors hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">
        {t.rich("body", {
          notice: (chunks: React.ReactNode) => (
            <Link
              href="/privacy"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>
      {currentChoice && (
        <p className="mt-2 text-[12px] text-fg-3">
          {t.rich("status", {
            state: t(currentChoice === "accepted" ? "statusOn" : "statusOff"),
            b: (chunks: React.ReactNode) => (
              <span className="font-medium text-fg-2">{chunks}</span>
            ),
          })}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => decide("rejected")}
          className="rounded-full px-4 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink"
        >
          {t("reject")}
        </button>
        <button
          type="button"
          onClick={() => decide("accepted")}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-fg-on-ink transition-colors hover:bg-ink-hover"
        >
          {t("accept")}
        </button>
      </div>
    </section>
  );
}
