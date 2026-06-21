"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Reveal-on-scroll wrapper.
 *
 * Content renders **visible by default**, so the server HTML, the pre-hydration
 * paint, and no-JS / non-executing crawlers always show it — the hero never
 * blanks and the LCP element isn't gated behind client JS. Once JS takes over we
 * only *arm* the fade for elements that are still below the fold; anything
 * already on screen (the hero, short pages) stays put with no flash. Armed
 * elements fade up the first time they cross into view (IntersectionObserver,
 * threshold 0.12), then stop observing.
 *
 * Honors `prefers-reduced-motion` (no fade at all). `delay` staggers siblings.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") return;

    let observer: IntersectionObserver | undefined;
    // Defer to the next frame: decide on layout that's settled, and keep the
    // setState out of the effect body (cascading-render lint).
    const raf = requestAnimationFrame(() => {
      // Already on screen → leave it visible. Hiding it now would flash on a
      // surface the user is looking at, and needlessly delay above-the-fold paint.
      if (el.getBoundingClientRect().top < window.innerHeight) return;
      setHidden(true);
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setHidden(false);
            observer?.disconnect();
          }
        },
        { threshold: 0.12 }
      );
      observer.observe(el);
    });

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-[600ms] ease-soft-out motion-reduce:transition-none ${
        hidden ? "opacity-0 translate-y-4" : "opacity-100 translate-y-0"
      } ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
