import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/**
 * Instant loading boundary for the dashboard. Shown the moment a link to
 * `/dashboard` is clicked while the (dynamic, auth-gated) page streams in —
 * turns the navigation into an instant client-side transition instead of a
 * blocking server round-trip with no feedback.
 */
export default function DashboardLoading() {
  return (
    <PageSkeleton width="wide">
      {/* Title + primary action row */}
      <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-7 w-48 rounded-md" />
          <SkeletonBlock className="h-4 w-32 rounded" delay={0.05} />
        </div>
        <SkeletonBlock className="h-9 w-32 rounded-full" delay={0.1} />
      </div>

      {/* Stat cards */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock
            key={i}
            className="h-28 rounded-xl"
            delay={0.1 + i * 0.05}
          />
        ))}
      </div>

      {/* Chart / activity panel */}
      <SkeletonBlock className="mt-4 h-80 rounded-xl" delay={0.3} />
    </PageSkeleton>
  );
}
