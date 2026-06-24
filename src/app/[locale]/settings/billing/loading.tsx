import {
  PageSkeleton,
  SkeletonBlock,
} from "@/app/_components/page-skeleton";

/** Instant loading boundary for the billing settings page. */
export default function BillingLoading() {
  return (
    <PageSkeleton width="narrow">
      <SkeletonBlock className="h-7 w-40 rounded-md" />
      <div className="mt-6 flex flex-col gap-4">
        <SkeletonBlock className="h-32 rounded-xl" delay={0.05} />
        <SkeletonBlock className="h-24 rounded-xl" delay={0.1} />
        <SkeletonBlock className="h-24 rounded-xl" delay={0.15} />
      </div>
    </PageSkeleton>
  );
}
