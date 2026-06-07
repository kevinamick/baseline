"use client";

import { useEffect, useState } from "react";

// Renders a locale/timezone-formatted date ONLY after mount. The server and the
// client's first render both emit the same placeholder, so locale/timezone
// differences can't cause a hydration mismatch; the localized value fills in after.
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
      setText(relative ? relativeTime(d) : dateOnly ? d.toLocaleDateString() : d.toLocaleString());
    });
    return () => {
      cancelled = true;
    };
  }, [value, placeholder, dateOnly, relative]);

  return <>{text}</>;
}

// Coarse, dependency-free relative time. Good enough for list rows ("3d ago"); for an
// exact timestamp use the absolute form.
function relativeTime(d: Date): string {
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
