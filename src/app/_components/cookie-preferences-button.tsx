"use client";

import { openConsentManager } from "@/app/_components/cookie-consent";

/**
 * Re-opens the cookie-consent banner so a visitor can change a prior choice
 * (#67 — consent must be revisitable). Rendered as inline text so it sits
 * naturally among footer links; pass `className` to match the host surface.
 */
export function CookiePreferencesButton({
  className,
  children = "Cookie preferences",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button type="button" onClick={() => openConsentManager()} className={className}>
      {children}
    </button>
  );
}
