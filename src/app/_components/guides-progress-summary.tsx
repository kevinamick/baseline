"use client";

import { useState, useEffect } from "react";

/**
 * Reads the checklist progress for all guides from localStorage and renders an
 * aggregate summary above the guides grid on the /docs index page. Shows nothing
 * before hydration (avoids server/client mismatch) and nothing when no guides
 * have been started (preserves the clean first-visit state). Uses the same
 * `guide-progress:{slug}` key as InteractiveStepList and GuideProgressBadge.
 */
export function GuidesProgressSummary({
  guides,
}: {
  guides: readonly { slug: string; stepCount: number }[];
}) {
  const [statuses, setStatuses] = useState<("complete" | "in-progress" | "not-started")[]>(() =>
    guides.map(() => "not-started")
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const next = guides.map(({ slug, stepCount }) => {
      try {
        const saved = localStorage.getItem(`guide-progress:${slug}`);
        if (!saved) return "not-started" as const;
        const parsed: unknown = JSON.parse(saved);
        if (!Array.isArray(parsed)) return "not-started" as const;
        const done = parsed.filter(Boolean).length;
        if (done === 0) return "not-started" as const;
        if (done >= stepCount) return "complete" as const;
        return "in-progress" as const;
      } catch {
        return "not-started" as const;
      }
    });
    setStatuses(next);
    setHydrated(true);
  }, [guides]);

  if (!hydrated) return null;

  const completeCount = statuses.filter((s) => s === "complete").length;
  const inProgressCount = statuses.filter((s) => s === "in-progress").length;

  if (completeCount === 0 && inProgressCount === 0) return null;

  const segmentClass = (status: "complete" | "in-progress" | "not-started") => {
    if (status === "complete") return "bg-success-fg";
    if (status === "in-progress") return "bg-accent";
    return "bg-fg-3/20";
  };

  const summaryParts: string[] = [];
  if (completeCount > 0) {
    summaryParts.push(`${completeCount} of ${guides.length} complete`);
  }
  if (inProgressCount > 0) {
    summaryParts.push(`${inProgressCount} in progress`);
  }

  return (
    <div className="mb-5 flex items-center gap-3">
      <div className="flex gap-1">
        {statuses.map((status, i) => (
          <div
            key={i}
            className={`h-1.5 w-6 rounded-full transition-colors ${segmentClass(status)}`}
          />
        ))}
      </div>
      <span className="text-[13px] text-fg-3">
        {summaryParts.join(" · ")}
      </span>
    </div>
  );
}
