import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/** Instant loading boundary for the rubrics list. */
export default function RubricsLoading() {
  return (
    <PageSkeleton width="wide">
      {/* Title + new-rubric action */}
      <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <SkeletonBlock className="h-7 w-36 rounded-md" />
        <SkeletonBlock className="h-9 w-36 rounded-full" delay={0.05} />
      </div>

      {/* Rubric card grid */}
      <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonBlock
            key={i}
            className="h-40 rounded-xl"
            delay={0.1 + i * 0.05}
          />
        ))}
      </div>
    </PageSkeleton>
  );
}
