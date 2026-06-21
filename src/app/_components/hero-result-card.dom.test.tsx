// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// Resolve translations against the real English catalog (with ICU args handled
// for the caption) so the card renders its shipped labels without a provider.
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json"))
    .default as unknown as Record<string, Record<string, string>>;
  return {
    useTranslations:
      (ns: string) =>
      (key: string, vars?: Record<string, string | number>) => {
        const raw = en[ns]?.[key] ?? key;
        return vars
          ? raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
          : raw;
      },
  };
});

import { HeroResultCard } from "./hero-result-card";

// The three illustrative criterion fills, in render order.
const TARGETS = ["96%", "93%", "91%"];

function barWidths(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".bg-accent")
  ).map((el) => el.style.width);
}

afterEach(() => {
  // @ts-expect-error — clear any matchMedia a test installed.
  delete window.matchMedia;
  vi.useRealTimers();
});

describe("HeroResultCard — static content", () => {
  it("renders the result labels, criteria, and the before/after figures", () => {
    render(<HeroResultCard />);

    expect(
      screen.getByText("Result quality · Customer support replies")
    ).toBeInTheDocument();
    expect(screen.getByText("After optimization")).toBeInTheDocument();
    expect(screen.getByText("Optimized")).toBeInTheDocument();

    expect(screen.getByText("Accuracy")).toBeInTheDocument();
    expect(screen.getByText("Tone")).toBeInTheDocument();
    expect(screen.getByText("Resolution")).toBeInTheDocument();

    // Before / after headline figures.
    expect(screen.getByText("61%")).toBeInTheDocument();
    expect(screen.getByText("94%")).toBeInTheDocument();

    // Caption interpolates the criteria count + eval rows.
    expect(
      screen.getByText("Weighted across 3 Criteria · 24 Eval Run Rows")
    ).toBeInTheDocument();
  });
});

describe("HeroResultCard — fill animation", () => {
  it("starts the bars at 0% and fills them to target a beat after mount", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<HeroResultCard />);

      // Pre-timer: every bar is collapsed.
      expect(barWidths(container)).toEqual(["0%", "0%", "0%"]);

      // The 400ms beat elapses → bars animate out to their criterion targets.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(barWidths(container)).toEqual(TARGETS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fill before the beat has fully elapsed", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<HeroResultCard />);
      act(() => {
        vi.advanceTimersByTime(399);
      });
      expect(barWidths(container)).toEqual(["0%", "0%", "0%"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HeroResultCard — reduced motion", () => {
  it("snaps the bars straight to target without waiting on the timer", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    // The reduced-motion path snaps on the next animation frame; fake timers
    // also stand in for requestAnimationFrame so we can flush it deterministically.
    vi.useFakeTimers();
    try {
      const { container } = render(<HeroResultCard />);
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(barWidths(container)).toEqual(TARGETS);
    } finally {
      vi.useRealTimers();
    }
  });
});
