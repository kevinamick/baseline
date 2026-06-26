// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CoachMark } from "./coach-mark";
import { Dialog } from "./dialog";

// A harness that pairs an active coach-mark with a real modal the user can open
// and close — exercising the same modal-presence registry production uses.
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CoachMark active message="Create your first rubric by clicking +." label="Getting started">
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
      <CoachMark active={false} message="hidden">
        <button type="button">New</button>
      </CoachMark>,
    );
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
  });
});
