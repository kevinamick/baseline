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
