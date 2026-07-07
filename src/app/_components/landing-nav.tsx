"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { BrandMark } from "./brand-mark";
import { SignInCta } from "./sign-in-cta";
import { SignUpCta } from "./sign-up-cta";
import { SignOutButton } from "./sign-out-button";
import { NavMenuSheet, navSheetItem } from "./nav-menu-sheet";

// In-page jump links. Plain anchors (not the locale-aware Link) — these target
// hash sections on the same page, so locale prefixing/routing doesn't apply.
// Listed in the order the sections appear as you scroll, each label matching its
// section's own heading.
const JUMP_LINKS: { href: string; key: "navProblem" | "navOptimization" | "navFeatures" }[] = [
  { href: "#problem", key: "navProblem" },
  { href: "#optimize", key: "navOptimization" },
  { href: "#features", key: "navFeatures" },
];

// Keyboard focus ring — matches the app-wide focus-visible cobalt convention.
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The marketing landing nav. Sticky, transparent at the top, and on scroll it
 * gains a translucent paper background + hairline + blur (the `scrolled` state).
 * Auth-aware on the right: signed-out visitors get Sign in / Get started free;
 * signed-in users get Open Baseline (and a path to plans when they can subscribe).
 */
export function LandingNav({
  signedIn,
  canSubscribe,
}: {
  signedIn: boolean;
  canSubscribe: boolean;
}) {
  const t = useTranslations("Home");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-200 ${
        scrolled
          ? "border-b border-hairline-cool bg-[color-mix(in_srgb,var(--paper)_82%,transparent)] backdrop-blur-[8px]"
          : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-[72px] max-w-[1180px] items-center gap-2 px-6">
        <a
          href="#top"
          className={`flex items-center gap-2.5 rounded-sm text-[15px] font-semibold tracking-[-0.01em] text-ink ${FOCUS}`}
        >
          <BrandMark size={22} />
          Baseline
        </a>

        <nav className="ml-4 hidden items-center gap-0.5 md:flex">
          {JUMP_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={`rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:bg-card-warm hover:text-ink ${FOCUS}`}
            >
              {t(l.key)}
            </a>
          ))}
          <Link
            href="/docs"
            className={`rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:bg-card-warm hover:text-ink ${FOCUS}`}
          >
            {t("navDocs")}
          </Link>
          <Link
            href="/blog"
            className={`rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:bg-card-warm hover:text-ink ${FOCUS}`}
          >
            {t("navBlog")}
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <>
              {canSubscribe && (
                <Link
                  href="/pricing"
                  className={`hidden rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink md:inline-flex ${FOCUS}`}
                >
                  {t("viewPlans")}
                </Link>
              )}
              <Link
                href="/dashboard"
                className={`rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover ${FOCUS}`}
              >
                {t("openBaseline")}
                <span aria-hidden="true"> →</span>
              </Link>
              <SignOutButton className={`hidden rounded-full border border-hairline-cool bg-card px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink md:inline-flex ${FOCUS}`} />
            </>
          ) : (
            <>
              {/* Pricing + Sign in collapse into the mobile sheet below md; the
                  primary Get-started CTA stays in the bar at every width. */}
              <Link
                href="/pricing"
                className={`hidden rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:bg-card-warm hover:text-ink md:inline-flex ${FOCUS}`}
              >
                {t("navPricing")}
              </Link>
              <SignInCta className={`hidden rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:bg-card-warm hover:text-ink md:inline-flex ${FOCUS}`}>
                {t("signIn")}
              </SignInCta>
              <SignUpCta className={`rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover ${FOCUS}`}>
                {t("getStartedFree")}
              </SignUpCta>
            </>
          )}

          {/* Mobile menu — surfaces the jump links, Docs, and the actions that
              hide below md (Pricing / Sign in / Sign out). */}
          <NavMenuSheet label={t("menu")} triggerClassName="md:hidden">
            {(close) => (
              <>
                {JUMP_LINKS.map((l) => (
                  <a key={l.href} href={l.href} className={navSheetItem} onClick={close}>
                    {t(l.key)}
                  </a>
                ))}
                <Link href="/docs" className={navSheetItem} onClick={close}>
                  {t("navDocs")}
                </Link>
                <Link href="/blog" className={navSheetItem} onClick={close}>
                  {t("navBlog")}
                </Link>
                <div className="my-1 h-px bg-hairline-cool" />
                {signedIn ? (
                  <>
                    {canSubscribe && (
                      <Link href="/pricing" className={navSheetItem} onClick={close}>
                        {t("viewPlans")}
                      </Link>
                    )}
                    <SignOutButton className={`${navSheetItem} w-full`} />
                  </>
                ) : (
                  <>
                    <Link href="/pricing" className={navSheetItem} onClick={close}>
                      {t("navPricing")}
                    </Link>
                    <SignInCta className={navSheetItem}>{t("signIn")}</SignInCta>
                  </>
                )}
              </>
            )}
          </NavMenuSheet>
        </div>
      </div>
    </header>
  );
}
