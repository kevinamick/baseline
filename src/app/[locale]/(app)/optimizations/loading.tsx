import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/** Instant loading boundary for the optimizations list. */
export default function OptimizationsLoading() {
  return (
    <PageSkeleton width="wide">
      {/* Title + new-run action */}
      <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <SkeletonBlock className="h-7 w-52 rounded-md" />
        <SkeletonBlock className="h-9 w-40 rounded-full" delay={0.05} />
      </div>

      {/* Run cards */}
      <div className="mt-2 flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock
            key={i}
            className="h-20 rounded-xl"
            delay={0.1 + i * 0.05}
          />
        ))}
      </div>
    </PageSkeleton>
  );
}
