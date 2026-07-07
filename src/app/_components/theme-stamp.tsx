"use client";

import { useLayoutEffect } from "react";
import { THEME_SCRIPT } from "./theme-script";

/**
 * Client-side fallback for surfaces where the pre-paint ThemeScript never
 * executes. The not-found boundary ships an empty server shell — the layout's
 * `<head>` content (including the inline theme script) arrives only via the
 * RSC payload and is mounted by React, and browsers don't execute inline
 * scripts inserted that way. Since the whole page is client-rendered there,
 * nothing paints before hydration, so stamping in a layout effect (before this
 * commit paints) is equivalent to the pre-paint script — no flash.
 *
 * Reuses THEME_SCRIPT verbatim (single source): under the CSP's
 * 'strict-dynamic', a script element created by the nonce-trusted client
 * bundle is itself trusted, so no nonce is needed here. Idempotent — if the
 * boot script already ran (data-theme present), this is a no-op.
 */
export function ThemeStamp() {
  useLayoutEffect(() => {
    if (document.documentElement.getAttribute("data-theme")) return;
    const el = document.createElement("script");
    el.textContent = THEME_SCRIPT;
    document.head.appendChild(el);
    el.remove();
  }, []);
  return null;
}
