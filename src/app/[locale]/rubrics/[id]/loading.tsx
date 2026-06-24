import { SkeletonBlock } from "@/app/_components/page-skeleton";

/**
 * Instant loading boundary for a single rubric detail page. This route has its
 * own chrome (a sticky back-link header, no app nav bar), so the skeleton
 * mirrors that frame rather than using the shared PageSkeleton.
 */
export default function RubricDetailLoading() {
  return (
    <div className="min-h-screen bg-paper" role="status" aria-busy="true">
      <header className="sticky top-0 z-10 flex w-full items-center justify-between px-6 py-4">
        <SkeletonBlock className="h-9 w-24 rounded-full" />
        <SkeletonBlock className="h-7 w-28 rounded-full" delay={0.05} />
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        {/* Title block */}
        <div className="mb-8 flex flex-col gap-3">
          <SkeletonBlock className="h-9 w-2/3 rounded-md" delay={0.1} />
          <SkeletonBlock className="h-4 w-full rounded" delay={0.15} />
          <SkeletonBlock className="h-4 w-4/5 rounded" delay={0.2} />
        </div>

        {/* Criteria / panel blocks */}
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <SkeletonBlock
              key={i}
              className="h-24 rounded-xl"
              delay={0.25 + i * 0.05}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
