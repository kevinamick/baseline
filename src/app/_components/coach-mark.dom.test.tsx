// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CoachMark } from "./coach-mark";
import { Dialog } from "./dialog";

// Point the anchor span's measurement at a chosen viewport rect, then nudge the
// component's resize listener so the next rAF-coalesced measure picks it up.
// (The mount-time measure has already run by the time render() returns, so the
// mock alone isn't enough.)
function placeAnchorAt(rect: Partial<DOMRect>) {
  const anchor = screen.getByRole("button", { name: "New" })
    .parentElement as HTMLElement;
  Object.defineProperty(anchor, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }),
  });
  fireEvent(window, new Event("resize"));
}

// A harness that pairs an active coach-mark with a real modal the user can open
// and close — exercising the same modal-presence registry production uses.
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CoachMark
        active
        title="Create your first rubric"
        message="This is where you create rubrics. Click New to make your first one."
      >
        <button type="button" onClick={() => setOpen(true)}>
          New
        </button>
      </CoachMark>
      {open && (
        <Dialog ariaLabel="Create rubric" onClose={() => setOpen(false)}>
          <button type="button" onClick={() => setOpen(false)}>
            Close dialog
          </button>
        </Dialog>
      )}
    </>
  );
}

describe("CoachMark – never obscures a modal", () => {
  it("hides the coach-mark while a modal is open and restores it after close", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Visible to begin with.
    expect(screen.getByTestId("coach-mark")).toBeInTheDocument();

    // Open the modal — the coach-mark popup steps aside.
    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();

    // Close the modal — the coach-mark returns.
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("coach-mark")).toBeInTheDocument();
  });

  it("does not render the popup or ring when inactive", () => {
    render(
      <CoachMark active={false} title="hidden" message="hidden">
        <button type="button">New</button>
      </CoachMark>,
    );
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
  });
});

describe("CoachMark – viewport-aware placement", () => {
  it("renders below the target by default", () => {
    render(
      <CoachMark active title="t" message="m">
        <button type="button">New</button>
      </CoachMark>,
    );
    expect(screen.getByTestId("coach-mark")).toHaveAttribute(
      "data-placement",
      "below",
    );
  });

  it("flips above when the popup would overflow the viewport bottom", async () => {
    render(
      <CoachMark active title="t" message="m">
        <button type="button">New</button>
      </CoachMark>,
    );
    // jsdom's viewport is 1024×768; a target hugging the bottom edge leaves no
    // room below (even for jsdom's zero-height popup, once the gap + viewport
    // margin are added) and plenty above.
    placeAnchorAt({ top: 750, bottom: 766, left: 100, right: 160, width: 60 });
    await waitFor(() =>
      expect(screen.getByTestId("coach-mark")).toHaveAttribute(
        "data-placement",
        "above",
      ),
    );
  });

  it("withholds the popup while the target is scrolled out of the viewport", async () => {
    render(
      <CoachMark active title="t" message="m">
        <button type="button">New</button>
      </CoachMark>,
    );
    expect(screen.getByTestId("coach-mark")).toBeInTheDocument();
    // Fully above the viewport — a fixed popup would float pointing at nothing.
    placeAnchorAt({ top: -36, bottom: -20, left: 100, right: 160, width: 60 });
    await waitFor(() =>
      expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument(),
    );
    // Scrolled back into view — the popup returns.
    placeAnchorAt({ top: 200, bottom: 216, left: 100, right: 160, width: 60 });
    await waitFor(() =>
      expect(screen.getByTestId("coach-mark")).toBeInTheDocument(),
    );
  });
});
