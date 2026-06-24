import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/** Instant loading boundary for the schedules list. */
export default function SchedulesLoading() {
  return (
    <PageSkeleton width="wide">
      {/* Title + new-schedule action */}
      <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <SkeletonBlock className="h-7 w-40 rounded-md" />
        <SkeletonBlock className="h-9 w-36 rounded-full" delay={0.05} />
      </div>

      {/* List rows */}
      <div className="mt-2 flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonBlock
            key={i}
            className="h-16 rounded-xl"
            delay={0.1 + i * 0.05}
          />
        ))}
      </div>
    </PageSkeleton>
  );
}
