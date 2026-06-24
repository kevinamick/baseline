import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/** Instant loading boundary for the account settings page. */
export default function AccountLoading() {
  return (
    <PageSkeleton width="narrow">
      <SkeletonBlock className="h-7 w-36 rounded-md" />
      <div className="mt-6 flex flex-col gap-4">
        <SkeletonBlock className="h-12 rounded-lg" delay={0.05} />
        <SkeletonBlock className="h-12 rounded-lg" delay={0.1} />
        <SkeletonBlock className="h-28 rounded-xl" delay={0.15} />
      </div>
    </PageSkeleton>
  );
}
