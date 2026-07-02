// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WizardShell, useWizardNav, type WizardNav } from "./wizard-shell";

// WizardShell is the shared chrome + nav state machine behind every stepped wizard
// dialog (schedules, optimizations, …). Exercise it the way a consumer does: wire
// useWizardNav's state into WizardShell and drive it through user interaction, the
// same harness style as email-tags-field.dom.test.tsx.

function Harness({
  initialSteps = ["a", "b", "c"],
  validateStep = () => null,
  onClose = vi.fn(),
  onSubmit = vi.fn(),
  onNav,
}: {
  initialSteps?: readonly string[];
  validateStep?: (stepName: string) => string | null;
  onClose?: () => void;
  onSubmit?: (nav: WizardNav) => void;
  onNav?: (nav: WizardNav) => void;
}) {
  const [steps, setSteps] = useState<readonly string[]>(initialSteps);
  const nav = useWizardNav(steps, validateStep);
  onNav?.(nav);
  return (
    <>
      <WizardShell
        title="Test Wizard"
        titleId="test-wizard-title"
        nav={nav}
        onClose={onClose}
        onSubmit={() => onSubmit(nav)}
        submitLabel="Finish"
        submittingLabel="Finishing…"
      >
        <div data-testid="step-content">{nav.stepName}</div>
      </WizardShell>
      <button type="button" onClick={() => setSteps(["a"])}>
        Shrink steps
      </button>
      <button type="button" onClick={() => nav.setSubmitting(true)}>
        Force submitting
      </button>
      <button type="button" onClick={() => nav.goToStep("c", "Jumped forward")}>
        Jump forward to c
      </button>
      <button type="button" onClick={() => nav.goToStepByIndex(nav.step)}>
        Jump to current index
      </button>
    </>
  );
}

describe("WizardShell", () => {
  it("renders the title, step pills, and disables Back on the first step", () => {
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Test Wizard" })).toBeInTheDocument();
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");

    const steps = screen.getByRole("list", { name: "Steps" });
    const current = within(steps).getByText("a");
    expect(current.closest("li")).toHaveAttribute("aria-current", "step");

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish" })).not.toBeInTheDocument();
  });

  it("advances to the next step on Next and enables Back", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByTestId("step-content")).toHaveTextContent("b");
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("blocks navigation and shows the step error when validation fails", async () => {
    const user = userEvent.setup();
    render(<Harness validateStep={(name) => (name === "a" ? "Fix this first" : null)} />);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Fix this first");
    // Still on step "a" — validation blocked the advance.
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");
  });

  it("clears the step error once validation passes", async () => {
    const user = userEvent.setup();
    let blocked = true;
    render(<Harness validateStep={(name) => (name === "a" && blocked ? "Fix this first" : null)} />);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    blocked = false;
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("step-content")).toHaveTextContent("b");
  });

  it("goBack returns to the previous step and re-disables Back at step 0", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("step-content")).toHaveTextContent("b");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("only renders a breadcrumb as clickable up to maxReachedStep", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Only ever reached step "a" so far — "c" should be inert text, not a button.
    expect(screen.queryByRole("button", { name: "Go to c step" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" })); // -> b, maxReached=1
    expect(screen.getByRole("button", { name: "Go to a step" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to c step" })).not.toBeInTheDocument();
  });

  it("clicking a reached breadcrumb jumps directly to that step", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Next" })); // -> b
    await user.click(screen.getByRole("button", { name: "Next" })); // -> c
    expect(screen.getByTestId("step-content")).toHaveTextContent("c");

    await user.click(screen.getByRole("button", { name: "Go to a step" }));
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");
  });

  it("clicking a reached breadcrumb ahead of the current step jumps forward", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Next" })); // -> b, maxReached=1
    await user.click(screen.getByRole("button", { name: "Go to a step" })); // back to a
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");

    await user.click(screen.getByRole("button", { name: "Go to b step" })); // forward jump
    expect(screen.getByTestId("step-content")).toHaveTextContent("b");
  });

  it("goToStepByIndex is a no-op when the target is already the current step", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Jump to current index" }));
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the Finish button (not Next) on the last step and calls onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    const finish = screen.getByRole("button", { name: "Finish" });
    await user.click(finish);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("disables the submit button and swaps its label while submitting", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Force submitting" }));

    const finish = screen.getByRole("button", { name: "Finishing…" });
    expect(finish).toBeDisabled();
  });

  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clamps the active step when the step list shrinks", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Next" })); // -> b
    await user.click(screen.getByRole("button", { name: "Next" })); // -> c
    expect(screen.getByTestId("step-content")).toHaveTextContent("c");

    await user.click(screen.getByRole("button", { name: "Shrink steps" }));

    // Only "a" remains — the index clamps to the last valid step.
    expect(screen.getByTestId("step-content")).toHaveTextContent("a");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("goToStep jumps to a named step (backward) and attaches a submit-time error", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        onSubmit={(nav) => nav.goToStep("a", "Server rejected this")}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // -> b
    await user.click(screen.getByRole("button", { name: "Next" })); // -> c
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(screen.getByTestId("step-content")).toHaveTextContent("a");
    expect(screen.getByRole("alert")).toHaveTextContent("Server rejected this");
  });

  it("goToStep jumps forward to a named step ahead of the current one", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Still on step "a" — jump forward to "c" (the ternary's other branch from
    // the backward-jump case already covered above).
    await user.click(screen.getByRole("button", { name: "Jump forward to c" }));

    expect(screen.getByTestId("step-content")).toHaveTextContent("c");
    expect(screen.getByRole("alert")).toHaveTextContent("Jumped forward");
  });

  it("goToStep is a no-op when the named step is not in the active step list", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        onSubmit={(nav) => nav.goToStep("not-a-real-step", "should not appear")}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // -> b
    await user.click(screen.getByRole("button", { name: "Next" })); // -> c
    await user.click(screen.getByRole("button", { name: "Finish" }));

    // No navigation and no error attached — the call was a no-op.
    expect(screen.getByTestId("step-content")).toHaveTextContent("c");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
