"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

// Client-only date text: the server can't know the viewer's timezone, so the
// value fills in after mount (placeholder-first), keeping server and client
// first paint identical.
export function ClientDate({
  value,
  placeholder = "—",
  dateOnly = false,
  relative = false,
}: {
  value: string | null;
  placeholder?: string;
  dateOnly?: boolean;
  // When true, render a coarse relative time ("2h ago", "just now") instead of an
  // absolute locale string. Like the others, it fills in only after mount.
  relative?: boolean;
}) {
  // Format in the app's selected locale (the language switcher), not the
  // browser's — an es/fr session shouldn't show English-shaped dates.
  const locale = useLocale();
  const [text, setText] = useState<string>(value ? "…" : placeholder);

  useEffect(() => {
    let cancelled = false;
    // Defer past the synchronous first render so server/client first paint match.
    Promise.resolve().then(() => {
      if (cancelled) return;
      if (!value) {
        setText(placeholder);
        return;
      }
      const d = new Date(value);
      setText(
        relative
          ? relativeTime(d, locale)
          : dateOnly
            ? d.toLocaleDateString(locale, { dateStyle: "medium" })
            : // Medium date + short time ("Jul 2, 2026, 4:13 PM") — seconds are
              // noise at the cadence anything in the app changes.
              d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [value, placeholder, dateOnly, relative, locale]);

  return <>{text}</>;
}

// Coarse relative time via Intl.RelativeTimeFormat, so es/fr sessions read
// "hace 3 días"/"il y a 3 j" without catalog keys. Good enough for list rows;
// for an exact timestamp use the absolute form. Sub-minute uses the unit
// formatter's own "now" idiom (numeric: "auto" at 0 seconds). Style is
// "short", not "narrow" — French narrow renders the minus notation ("-3 j").
function relativeTime(d: Date, locale: string): string {
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 45) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  }
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  const months = Math.round(days / 30);
  if (months < 12) return rtf.format(-months, "month");
  return rtf.format(-Math.round(months / 12), "year");
}
