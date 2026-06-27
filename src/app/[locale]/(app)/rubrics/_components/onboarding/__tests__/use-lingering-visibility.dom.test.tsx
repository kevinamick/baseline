// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useLingeringVisibility } from "../use-lingering-visibility";

// Records the hook's return value on every render so we can observe the
// lingering render that a settled DOM snapshot would hide from us.
function Probe({ live, sink }: { live: boolean; sink: boolean[] }) {
  sink.push(useLingeringVisibility(live));
  return null;
}

describe("useLingeringVisibility", () => {
  it("stays visible through the render where live flips false, then hides on the next", () => {
    const sink: boolean[] = [];
    const { rerender } = render(<Probe live sink={sink} />);
    expect(sink).toEqual([true]);

    sink.length = 0;
    rerender(<Probe live={false} sink={sink} />);

    // The flip render still read visible (lingered); a follow-up render settled
    // to hidden — the disappearance is tied to the next render, not the flip.
    expect(sink[0]).toBe(true);
    expect(sink.at(-1)).toBe(false);
  });

  it("never flashes visible when live starts false (existing users see nothing)", () => {
    const sink: boolean[] = [];
    render(<Probe live={false} sink={sink} />);
    expect(sink).toEqual([false]);
  });

  it("shows immediately when live becomes true", () => {
    const sink: boolean[] = [];
    const { rerender } = render(<Probe live={false} sink={sink} />);
    sink.length = 0;
    rerender(<Probe live sink={sink} />);
    expect(sink.at(-1)).toBe(true);
  });
});
