import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/** Instant loading boundary for the team settings page. */
export default function TeamLoading() {
  return (
    <PageSkeleton width="narrow">
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-7 w-32 rounded-md" />
        <SkeletonBlock className="h-9 w-32 rounded-full" delay={0.05} />
      </div>
      <div className="mt-6 flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock
            key={i}
            className="h-14 rounded-xl"
            delay={0.1 + i * 0.05}
          />
        ))}
      </div>
    </PageSkeleton>
  );
}
