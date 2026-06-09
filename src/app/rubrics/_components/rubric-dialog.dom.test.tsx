// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockCreateRubric } = vi.hoisted(() => ({
  mockCreateRubric: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/app/actions/rubrics", () => ({
  createRubric: mockCreateRubric,
  updateRubric: vi.fn().mockResolvedValue({}),
  getRubric: vi.fn().mockResolvedValue(null),
  deleteRubric: vi.fn().mockResolvedValue({}),
}));

// Stub Dialog to a plain container so focus-trap/scroll side-effects don't run.
vi.mock("@/app/_components/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog" aria-modal="true">
      {children}
    </div>
  ),
}));

vi.mock("@/lib/validation/focus-first-error", () => ({
  focusFirstError: vi.fn(),
}));

import { RubricDialog } from "./rubric-dialog";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RubricDialog — create mode", () => {
  it("renders all labeled form fields", () => {
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Evaluation mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Scenario description")).toBeInTheDocument();
    expect(screen.getByLabelText("Expected outcome")).toBeInTheDocument();
  });

  it("inputs suppress the browser default outline in favour of a custom focus ring", () => {
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    const nameInput = screen.getByLabelText("Name");
    // outline-none removes the UA default; focus:ring-[3px] + ring-accent provides
    // the branded cobalt ring that meets WCAG 2.4 Focus Visible.
    expect(nameInput.className).toContain("outline-none");
    expect(nameInput.className).toContain("focus:ring-[3px]");
    expect(nameInput.className).toContain("ring-accent");
  });

  it("sets aria-invalid on required fields when the form is submitted empty", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Create rubric" }));

    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Scenario description")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Expected outcome")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("clears the Name field error as soon as the user begins typing", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Create rubric" }));

    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    await user.type(nameInput, "My rubric");
    expect(nameInput).not.toHaveAttribute("aria-invalid", "true");
  });

  it("has accessible error messages for validation failures", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Create rubric" }));

    // Field-level error text should be visible in the DOM.
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Scenario description is required")).toBeInTheDocument();
    expect(screen.getByText("Expected outcome is required")).toBeInTheDocument();
  });
});
