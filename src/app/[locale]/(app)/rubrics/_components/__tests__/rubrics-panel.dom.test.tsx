// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { RubricsPanel } from "../rubrics-panel";
import type { RubricSummary } from "@/types/rubric";
import enMessages from "../../../../../../../messages/en.json";

// Stub the dialog but surface its `onCreated` callback so we can assert the panel
// auto-selects the newly created rubric (#330) without driving the real form.
vi.mock("../rubric-dialog", () => ({
  RubricDialog: (props: { onCreated?: (id: string) => void }) => (
    <div data-testid="rubric-dialog">
      {props.onCreated && (
        <button
          type="button"
          data-testid="simulate-created"
          onClick={() => props.onCreated!("new-rubric-id")}
        >
          simulate created
        </button>
      )}
    </div>
  ),
}));

vi.mock("@/app/actions/rubrics", () => ({
  deleteRubric: vi.fn(),
}));

vi.mock("@/lib/analytics/client", () => ({
  track: vi.fn(),
}));

// Dates are intentionally non-alphabetical so each sort order gives a distinct result.
// Newest: Support (Jan 3) → Coding (Jan 2) → Sales (Jan 1)
// Oldest: Sales (Jan 1) → Coding (Jan 2) → Support (Jan 3)
// A–Z:    Coding → Sales → Support
const RUBRICS: RubricSummary[] = [
  {
    id: "1",
    name: "Support reply quality",
    evaluation_mode: "conversational",
    created_at: "2026-01-03T00:00:00Z",
  },
  {
    id: "2",
    name: "Sales email quality",
    evaluation_mode: "prompt_response",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "3",
    name: "Coding assistant review",
    evaluation_mode: "conversational",
    created_at: "2026-01-02T00:00:00Z",
  },
];

function renderPanel(overrides: Partial<Parameters<typeof RubricsPanel>[0]> = {}) {
  const props = {
    rubrics: RUBRICS,
    selectedId: null,
    onSelect: vi.fn(),
    canWrite: false,
    ...overrides,
  };
  return {
    ...render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <RubricsPanel {...props} />
      </NextIntlClientProvider>,
    ),
    props,
  };
}

// --- Search input visibility ---

describe("RubricsPanel – filter controls", () => {
  it("shows the search input when rubrics exist", () => {
    renderPanel();
    expect(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
    ).toBeInTheDocument();
  });

  it("shows the sort select when rubrics exist", () => {
    renderPanel();
    expect(
      screen.getByRole("combobox", { name: /sort rubrics/i }),
    ).toBeInTheDocument();
  });

  it("hides the search input when the list is empty", () => {
    renderPanel({ rubrics: [] });
    expect(
      screen.queryByRole("textbox", { name: /filter rubrics by name/i }),
    ).not.toBeInTheDocument();
  });

  it("shows all three rubrics initially", () => {
    renderPanel();
    expect(screen.getByText("Support reply quality")).toBeInTheDocument();
    expect(screen.getByText("Sales email quality")).toBeInTheDocument();
    expect(screen.getByText("Coding assistant review")).toBeInTheDocument();
  });
});

// --- Name filtering ---

describe("RubricsPanel – name filter", () => {
  it("shows only matching rubrics when the user types in the search input", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "sales",
    );

    expect(screen.getByText("Sales email quality")).toBeInTheDocument();
    expect(
      screen.queryByText("Support reply quality"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Coding assistant review"),
    ).not.toBeInTheDocument();
  });

  it("is case-insensitive", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "CODING",
    );

    expect(screen.getByText("Coding assistant review")).toBeInTheDocument();
    expect(
      screen.queryByText("Support reply quality"),
    ).not.toBeInTheDocument();
  });

  it("shows a no-results message when nothing matches", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "zzznomatch",
    );

    expect(screen.getByText(/no rubrics match your filter/i)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows a clear button when there is query text", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(
      screen.queryByRole("button", { name: /clear filter/i }),
    ).not.toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "sales",
    );

    expect(
      screen.getByRole("button", { name: /clear filter/i }),
    ).toBeInTheDocument();
  });

  it("clears the query and restores all rubrics when the clear button is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();

    const input = screen.getByRole("textbox", { name: /filter rubrics by name/i });
    await user.type(input, "sales");

    expect(screen.queryByText("Support reply quality")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /clear filter/i }));

    expect(input).toHaveValue("");
    expect(screen.getByText("Support reply quality")).toBeInTheDocument();
    expect(screen.getByText("Sales email quality")).toBeInTheDocument();
    expect(screen.getByText("Coding assistant review")).toBeInTheDocument();
  });
});

// --- Sort order ---

describe("RubricsPanel – sort order", () => {
  it("defaults to newest-first order", () => {
    renderPanel();
    const items = screen.getAllByRole("listitem");
    // Newest: Support (Jan 3) → Coding (Jan 2) → Sales (Jan 1)
    expect(items[0]).toHaveTextContent("Support reply quality");
    expect(items[1]).toHaveTextContent("Coding assistant review");
    expect(items[2]).toHaveTextContent("Sales email quality");
  });

  it("sorts alphabetically when A–Z is selected", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /sort rubrics/i }),
      "name",
    );

    const items = screen.getAllByRole("listitem");
    // A-Z: Coding < Sales < Support
    expect(items[0]).toHaveTextContent("Coding assistant review");
    expect(items[1]).toHaveTextContent("Sales email quality");
    expect(items[2]).toHaveTextContent("Support reply quality");
  });

  it("sorts oldest-first when Oldest is selected", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /sort rubrics/i }),
      "oldest",
    );

    const items = screen.getAllByRole("listitem");
    // Oldest first: Sales (Jan 1) → Coding (Jan 2) → Support (Jan 3)
    expect(items[0]).toHaveTextContent("Sales email quality");
    expect(items[1]).toHaveTextContent("Coding assistant review");
    expect(items[2]).toHaveTextContent("Support reply quality");
  });
});

// --- Integration: filter + sort + selection ---

describe("RubricsPanel – filter and sort combined", () => {
  it("applies sort to filtered results", async () => {
    const user = userEvent.setup();
    renderPanel();

    // Filter to only "quality" rubrics (Support + Sales)
    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "quality",
    );

    // Sort oldest first
    await user.selectOptions(
      screen.getByRole("combobox", { name: /sort rubrics/i }),
      "oldest",
    );

    const items = screen.getAllByRole("listitem");
    // Oldest first among matching: Sales (Jan 1) → Support (Jan 3)
    expect(items[0]).toHaveTextContent("Sales email quality");
    expect(items[1]).toHaveTextContent("Support reply quality");
    expect(items).toHaveLength(2);
  });

  it("calls onSelect with the rubric id when a filtered item is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPanel({ onSelect });

    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "sales",
    );

    await user.click(
      screen.getByRole("button", { name: /Sales email quality/i }),
    );

    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("auto-selects the new rubric when one is created (canWrite, existing rubrics)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPanel({ canWrite: true, onSelect });

    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(screen.getByTestId("simulate-created"));

    expect(onSelect).toHaveBeenCalledWith("new-rubric-id");
  });

  it("auto-selects the first rubric created from the empty state", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPanel({ rubrics: [], canWrite: true, onSelect });

    await user.click(screen.getByRole("button", { name: /create your first rubric/i }));
    await user.click(screen.getByTestId("simulate-created"));

    expect(onSelect).toHaveBeenCalledWith("new-rubric-id");
  });

  it("selected item remains highlighted after filtering", async () => {
    const user = userEvent.setup();
    renderPanel({ selectedId: "2" });

    // Type partial filter that still includes item 2
    await user.type(
      screen.getByRole("textbox", { name: /filter rubrics by name/i }),
      "quality",
    );

    // Sales is still in the list
    expect(screen.getByText("Sales email quality")).toBeInTheDocument();
    // Its button should be aria-pressed=true (selected)
    expect(
      screen.getByRole("button", { name: /Sales email quality/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
