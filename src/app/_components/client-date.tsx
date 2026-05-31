"use client";

import { useEffect, useState } from "react";

// Renders a locale/timezone-formatted date ONLY after mount. The server and the
// client's first render both emit the same placeholder, so locale/timezone
// differences can't cause a hydration mismatch; the localized value fills in after.
export function ClientDate({
  value,
  placeholder = "—",
  dateOnly = false,
}: {
  value: string | null;
  placeholder?: string;
  dateOnly?: boolean;
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
      setText(dateOnly ? d.toLocaleDateString() : d.toLocaleString());
    });
    return () => {
      cancelled = true;
    };
  }, [value, placeholder, dateOnly]);

  return <>{text}</>;
}
