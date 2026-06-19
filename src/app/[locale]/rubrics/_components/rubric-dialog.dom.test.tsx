// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockCreateRubric, mockGetRubric } = vi.hoisted(() => ({
  mockCreateRubric: vi.fn(),
  mockGetRubric: vi.fn(),
}));

vi.mock("@/app/actions/rubrics", () => ({
  createRubric: mockCreateRubric,
  updateRubric: vi.fn(),
  getRubric: mockGetRubric,
  deleteRubric: vi.fn(),
}));

// Stub the focus-first-error helper — the form-a11y tests submit an empty form,
// which would otherwise drive real focus side-effects in jsdom.
vi.mock("@/lib/validation/focus-first-error", () => ({
  focusFirstError: vi.fn(),
}));

import { RubricDialog } from "./rubric-dialog";
import { RUBRIC_TEMPLATES } from "./rubric-templates";

// The rubric name field has placeholder "e.g. Customer support quality"; use it
// to distinguish the rubric-name input from the per-criterion "Name" inputs.
const RUBRIC_NAME_PLACEHOLDER = "e.g. Customer support quality";

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRubric.mockResolvedValue({ success: true });
  mockGetRubric.mockResolvedValue(null);
});

describe("RubricDialog — create mode", () => {
  it("shows the template picker on open, not the form", () => {
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    expect(
      screen.getByText("Start with a template or build your own from scratch.")
    ).toBeInTheDocument();
    // The rubric name input must not be visible yet.
    expect(
      screen.queryByPlaceholderText(RUBRIC_NAME_PLACEHOLDER)
    ).not.toBeInTheDocument();
  });

  it("renders a card for every template", () => {
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    for (const template of RUBRIC_TEMPLATES) {
      expect(screen.getByText(template.name)).toBeInTheDocument();
    }
  });

  it("renders a 'Start from scratch' option", () => {
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /start from scratch/i })
    ).toBeInTheDocument();
  });

  it("does not show the Create rubric submit button on the picker step", () => {
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /create rubric/i })
    ).not.toBeInTheDocument();
  });

  it("advances to the blank form when 'Start from scratch' is clicked", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /start from scratch/i }));

    const nameInput = screen.getByPlaceholderText(RUBRIC_NAME_PLACEHOLDER);
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveValue("");
    expect(
      screen.getByRole("button", { name: /create rubric/i })
    ).toBeInTheDocument();
  });

  it("pre-populates the form when a template is selected", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);

    const template = RUBRIC_TEMPLATES[0];
    await user.click(screen.getByTestId(`template-card-${template.id}`));

    // Rubric name field should be pre-filled with the template name.
    expect(screen.getByPlaceholderText(RUBRIC_NAME_PLACEHOLDER)).toHaveValue(
      template.name
    );
    // The template's scenario description should appear in its textarea.
    expect(
      screen.getByDisplayValue(template.scenario_description)
    ).toBeInTheDocument();
    // All criteria names should appear.
    for (const criterion of template.criteria) {
      expect(screen.getByDisplayValue(criterion.name)).toBeInTheDocument();
    }
  });

  it("shows 'Customer Support Standard' template content in the form after selection", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);

    await user.click(
      screen.getByTestId("template-card-customer-support-standard")
    );

    expect(
      screen.getByPlaceholderText(RUBRIC_NAME_PLACEHOLDER)
    ).toHaveValue("Customer Support Standard");
    expect(
      screen.getByRole("button", { name: /create rubric/i })
    ).toBeInTheDocument();
  });

  it("shows 'Sales Tone Verification' template content after selection", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);

    await user.click(
      screen.getByTestId("template-card-sales-tone-verification")
    );

    expect(
      screen.getByPlaceholderText(RUBRIC_NAME_PLACEHOLDER)
    ).toHaveValue("Sales Tone Verification");
  });

  it("shows a Back button on the form step and returns to the picker", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /start from scratch/i }));
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back/i }));

    // Back to picker.
    expect(
      screen.getByText("Start with a template or build your own from scratch.")
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(RUBRIC_NAME_PLACEHOLDER)
    ).not.toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<RubricDialog mode="create" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("RubricDialog — edit mode", () => {
  const fakeRubric = {
    id: "rubric-1",
    name: "Existing Rubric",
    evaluation_mode: "prompt_response",
    scenario_description: "Test scenario",
    expected_outcome: "Test outcome",
    grounding_context: null,
    criteria: [
      { name: "Accuracy", weight: 1, steps: ["Check accuracy"] },
    ],
  };

  it("goes straight to the form (no template picker)", () => {
    mockGetRubric.mockResolvedValue(fakeRubric);
    render(
      <RubricDialog mode="edit" rubricId="rubric-1" onClose={vi.fn()} />
    );

    // Template picker text must not appear.
    expect(
      screen.queryByText(
        "Start with a template or build your own from scratch."
      )
    ).not.toBeInTheDocument();
  });

  it("does not show template cards in edit mode", () => {
    mockGetRubric.mockResolvedValue(fakeRubric);
    render(
      <RubricDialog mode="edit" rubricId="rubric-1" onClose={vi.fn()} />
    );

    for (const template of RUBRIC_TEMPLATES) {
      expect(screen.queryByText(template.name)).not.toBeInTheDocument();
    }
  });
});

// Form-level accessibility (labels, focus ring, validation) — the create flow
// now opens on the template picker, so reach the blank form via "Start from
// scratch" before asserting. The rubric Name field is scoped to #rubric-name
// since each criterion row also carries a "Name" label.
describe("RubricDialog — create form a11y", () => {
  async function openBlankForm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /start from scratch/i }));
  }

  it("renders all labeled form fields", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await openBlankForm(user);
    expect(
      screen.getByLabelText("Name", { selector: "#rubric-name" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Evaluation mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Scenario description")).toBeInTheDocument();
    expect(screen.getByLabelText("Expected outcome")).toBeInTheDocument();
  });

  it("inputs suppress the browser default outline in favour of a custom focus ring", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await openBlankForm(user);
    const nameInput = screen.getByLabelText("Name", { selector: "#rubric-name" });
    // outline-none removes the UA default; focus:ring-[3px] + ring-accent provides
    // the branded cobalt ring that meets WCAG 2.4 Focus Visible.
    expect(nameInput.className).toContain("outline-none");
    expect(nameInput.className).toContain("focus:ring-[3px]");
    expect(nameInput.className).toContain("ring-accent");
  });

  it("sets aria-invalid on required fields when the form is submitted empty", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await openBlankForm(user);
    await user.click(screen.getByRole("button", { name: "Create rubric" }));

    expect(
      screen.getByLabelText("Name", { selector: "#rubric-name" })
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Scenario description")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByLabelText("Expected outcome")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("clears the Name field error as soon as the user begins typing", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await openBlankForm(user);
    await user.click(screen.getByRole("button", { name: "Create rubric" }));

    const nameInput = screen.getByLabelText("Name", { selector: "#rubric-name" });
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    await user.type(nameInput, "My rubric");
    expect(nameInput).not.toHaveAttribute("aria-invalid", "true");
  });

  it("has accessible error messages for validation failures", async () => {
    const user = userEvent.setup();
    render(<RubricDialog mode="create" onClose={vi.fn()} />);
    await openBlankForm(user);
    await user.click(screen.getByRole("button", { name: "Create rubric" }));

    // Field-level error text should be visible in the DOM.
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Scenario description is required")).toBeInTheDocument();
    expect(screen.getByText("Expected outcome is required")).toBeInTheDocument();
  });
});
