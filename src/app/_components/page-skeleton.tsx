import type { CSSProperties, ReactNode } from "react";

/**
 * Shared loading-skeleton primitives for App Router `loading.tsx` boundaries.
 *
 * These render *instantly* with no async work — that is the whole point of a
 * loading boundary. The router shows this the moment a `<Link>` is clicked,
 * while the real (dynamic, auth-gated) page streams in behind it.
 *
 * Inside the `(app)` route group the `NavBar` now lives in the persistent
 * `layout.tsx`, so it stays painted across navigation and the page's
 * `loading.tsx` only ever replaces the content slot *below* it. `PageSkeleton`
 * therefore renders just the content frame (no nav, no full-screen wrapper) as
 * the `flex-1` child of that shell. `NavBarSkeleton` is kept for *bespoke*
 * loading boundaries on routes that own their chrome (no app nav) and need a
 * static nav placeholder of their own.
 */

/**
 * A single shimmering placeholder block. `delay` staggers the shine across
 * sibling blocks so the page reads as one coordinated sweep rather than every
 * block pulsing in lockstep. Decorative, so it is hidden from assistive tech.
 */
export function SkeletonBlock({
  className = "",
  delay = 0,
}: {
  className?: string;
  delay?: number;
}) {
  return (
    <div
      className={`skeleton-shimmer ${className}`}
      style={{ "--shimmer-delay": `${delay}s` } as CSSProperties}
      aria-hidden
    />
  );
}

/**
 * Static stand-in for the app nav bar. Mirrors the real header's layout
 * (`nav-bar-client.tsx`): logo pill, team switcher, center menu, right cluster —
 * so the swap to the loaded page doesn't shift the chrome.
 */
export function NavBarSkeleton() {
  return (
    <header
      className="mx-auto flex w-full max-w-[1360px] shrink-0 items-center gap-3 px-6 py-4"
      aria-hidden
    >
      {/* Logo pill */}
      <SkeletonBlock className="h-[38px] w-[132px] rounded-full" />
      {/* Team switcher pill (md+) */}
      <SkeletonBlock
        className="hidden h-[38px] w-[120px] rounded-full md:block"
        delay={0.05}
      />
      {/* Center menu (md+) */}
      <div className="hidden flex-1 justify-center md:flex">
        <SkeletonBlock
          className="h-[38px] w-[360px] rounded-full"
          delay={0.1}
        />
      </div>
      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-2">
        <SkeletonBlock className="h-9 w-9 rounded-full" delay={0.15} />
        <SkeletonBlock className="h-9 w-9 rounded-full" delay={0.2} />
      </div>
    </header>
  );
}

/**
 * Content loading frame for a route inside the `(app)` shell. Renders as the
 * `flex-1` child below the persistent nav, mirroring the page's own content
 * region so the swap to the loaded page doesn't shift layout.
 *
 * `width` matches the two content widths in the app — `wide` (the 1360px app
 * surfaces: dashboard, schedules, optimizations, rubrics) and `narrow` (the
 * 2xl settings column). The status role announces the loading state to screen
 * readers without spelling out the decorative blocks.
 */
export function PageSkeleton({
  width = "wide",
  children,
}: {
  width?: "wide" | "narrow";
  children: ReactNode;
}) {
  return (
    <div
      className={
        width === "wide"
          ? "mx-auto w-full max-w-[1360px] flex-1 px-6 pb-6"
          : "mx-auto w-full max-w-2xl flex-1 p-6"
      }
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {children}
    </div>
  );
}
