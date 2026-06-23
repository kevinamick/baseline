"use client";

import { useState, useEffect } from "react";

/**
 * Reads the guide's checklist progress from localStorage and renders a small pill
 * badge showing how many steps the current user has completed. Shows nothing before
 * hydration (avoids a server/client mismatch) and nothing when no progress is saved
 * (new user or guide not started). The storage key mirrors InteractiveStepList's
 * `guide-progress:{slug}` key so progress is shared between the index and the guide page.
 */
export function GuideProgressBadge({
  slug,
  stepCount,
}: {
  slug: string;
  stepCount: number;
}) {
  const [doneCount, setDoneCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`guide-progress:${slug}`);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setDoneCount(parsed.filter(Boolean).length);
        }
      }
    } catch {
      // localStorage unavailable — stay hidden
    }
    setHydrated(true);
  }, [slug]);

  if (!hydrated || doneCount === 0) return null;

  const allDone = doneCount >= stepCount;

  return (
    <span
      className={[
        "rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
        allDone
          ? "bg-success-bg text-success-fg"
          : "bg-accent/10 text-accent-ink",
      ].join(" ")}
    >
      {allDone ? "Complete" : `${doneCount}/${stepCount} done`}
    </span>
  );
}
