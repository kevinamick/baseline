// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
import { RubricsPanel } from "./rubrics-panel";
import { OnboardingProvider } from "./onboarding/onboarding-context";
import type { RubricSummary } from "@/types/rubric";

// RubricsPanel reads the `Rubrics` next-intl scope directly, so renders need a
// provider. `onError` rethrows on a missing message — same convention as
// connections-list.dom.test.tsx — so a key the component calls that's absent
// from the catalog fails the render instead of silently showing the key path.
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error) => {
        if (error.code === "MISSING_MESSAGE") throw error;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
}
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: Wrapper });
}

const mockDeleteRubric = vi.fn();
vi.mock("@/app/actions/rubrics", () => ({
  deleteRubric: (id: string) => mockDeleteRubric(id),
}));

// RubricDialog itself (criteria/steps editor, tier caps, BillingContext) is
// out of scope for this panel's tests — stub it with a tiny control surface
// that exercises how RubricsPanel wires mode/rubricId/onClose/onCreated,
// without pulling in the real editor's BillingProvider dependency.
const mockOnCreated = vi.fn();
vi.mock("./rubric-dialog", () => ({
  RubricDialog: (props: {
    mode: "create" | "edit";
    rubricId?: string;
    onClose: () => void;
    onCreated?: (id: string) => void;
  }) => (
    <div role="dialog" aria-label={`rubric-dialog-${props.mode}`}>
      <p>mode: {props.mode}</p>
      {props.rubricId && <p>rubricId: {props.rubricId}</p>}
      <button onClick={props.onClose}>Close stub dialog</button>
      {props.mode === "create" && (
        <button
          onClick={() => {
            mockOnCreated("new-rubric-id");
            props.onCreated?.("new-rubric-id");
          }}
        >
          Simulate created
        </button>
      )}
    </div>
  ),
}));

function rubric(overrides: Partial<RubricSummary> = {}): RubricSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Support quality",
    evaluation_mode: "prompt_response",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const onSelect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteRubric.mockResolvedValue(undefined);
});

describe("RubricsPanel — empty state", () => {
  it("shows the empty title and a create-first CTA for writers", () => {
    render(
      <RubricsPanel rubrics={[]} selectedId={null} onSelect={onSelect} canWrite />,
    );

    expect(screen.getByText("No rubrics yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create your first rubric/ }),
    ).toBeInTheDocument();
    // The search/sort bar only renders once there's at least one rubric.
    expect(screen.queryByLabelText("Filter rubrics by name")).not.toBeInTheDocument();
  });

  it("hides create affordances for read-only members", () => {
    render(
      <RubricsPanel
        rubrics={[]}
        selectedId={null}
        onSelect={onSelect}
        canWrite={false}
      />,
    );

    expect(screen.getByText("No rubrics yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create your first rubric/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
  });

  it("opens the create dialog from the empty-state CTA", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={[]} selectedId={null} onSelect={onSelect} canWrite />,
    );

    await user.click(screen.getByRole("button", { name: /Create your first rubric/ }));
    expect(screen.getByRole("dialog", { name: "rubric-dialog-create" })).toBeInTheDocument();
    expect(screen.getByText("mode: create")).toBeInTheDocument();
  });
});

describe("RubricsPanel — populated list", () => {
  const rubrics = [
    rubric({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Bravo checks",
      evaluation_mode: "conversational",
      created_at: "2026-02-01T00:00:00.000Z",
    }),
    rubric({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Alpha checks",
      evaluation_mode: "prompt_response",
      created_at: "2026-03-01T00:00:00.000Z",
    }),
  ];

  it("renders every rubric with its mode label and lets a writer pick one", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={rubrics} selectedId={null} onSelect={onSelect} canWrite />,
    );

    expect(screen.getByText("Bravo checks")).toBeInTheDocument();
    expect(screen.getByText("Alpha checks")).toBeInTheDocument();
    expect(screen.getByText("Conversational")).toBeInTheDocument();
    expect(screen.getByText("Prompt / Response")).toBeInTheDocument();

    await user.click(screen.getByText("Bravo checks"));
    expect(onSelect).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("marks the selected rubric's row as pressed", () => {
    render(
      <RubricsPanel
        rubrics={rubrics}
        selectedId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        onSelect={onSelect}
        canWrite
      />,
    );

    const selectedButton = screen.getByText("Bravo checks").closest("button");
    const unselectedButton = screen.getByText("Alpha checks").closest("button");
    expect(selectedButton).toHaveAttribute("aria-pressed", "true");
    expect(unselectedButton).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the edit/delete affordances for read-only members", () => {
    render(
      <RubricsPanel
        rubrics={rubrics}
        selectedId={null}
        onSelect={onSelect}
        canWrite={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Edit rubric" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete rubric" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
  });

  it("filters the list by name and shows the no-match state", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={rubrics} selectedId={null} onSelect={onSelect} canWrite />,
    );

    const filterInput = screen.getByLabelText("Filter rubrics by name");
    await user.type(filterInput, "bravo");
    expect(screen.getByText("Bravo checks")).toBeInTheDocument();
    expect(screen.queryByText("Alpha checks")).not.toBeInTheDocument();

    await user.clear(filterInput);
    await user.type(filterInput, "no such rubric");
    expect(screen.getByText("No rubrics match your filter.")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Clear filter"));
    expect(filterInput).toHaveValue("");
    expect(screen.getByText("Bravo checks")).toBeInTheDocument();
    expect(screen.getByText("Alpha checks")).toBeInTheDocument();
  });

  it("sorts by name and by oldest-first", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={rubrics} selectedId={null} onSelect={onSelect} canWrite />,
    );

    const list = screen.getByRole("list");
    // Default "newest" sort: Alpha (Mar) before Bravo (Feb).
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Alpha checks"),
      expect.stringContaining("Bravo checks"),
    ]);

    await user.selectOptions(screen.getByLabelText("Sort rubrics"), "name");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Alpha checks"),
      expect.stringContaining("Bravo checks"),
    ]);

    await user.selectOptions(screen.getByLabelText("Sort rubrics"), "oldest");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Bravo checks"),
      expect.stringContaining("Alpha checks"),
    ]);
  });
});

describe("RubricsPanel — create/edit dialog wiring", () => {
  const rubrics = [rubric()];

  it("opens the create dialog from the header New button and forwards onCreated to onSelect", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={rubrics} selectedId={null} onSelect={onSelect} canWrite />,
    );

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("dialog", { name: "rubric-dialog-create" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Simulate created" }));
    expect(mockOnCreated).toHaveBeenCalledWith("new-rubric-id");
    expect(onSelect).toHaveBeenCalledWith("new-rubric-id");
  });

  it("closes the create dialog via its onClose callback", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={rubrics} selectedId={null} onSelect={onSelect} canWrite />,
    );

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("dialog", { name: "rubric-dialog-create" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close stub dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the edit dialog for the clicked rubric and closes it", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={rubrics} selectedId={null} onSelect={onSelect} canWrite />,
    );

    await user.click(screen.getByRole("button", { name: "Edit rubric" }));
    expect(screen.getByRole("dialog", { name: "rubric-dialog-edit" })).toBeInTheDocument();
    expect(screen.getByText(`rubricId: ${rubrics[0].id}`)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close stub dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("RubricsPanel — delete flow", () => {
  const target = rubric({ name: "Doomed rubric" });

  it("requires a second confirming click before calling deleteRubric, then closes", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={[target]} selectedId={null} onSelect={onSelect} canWrite />,
    );

    await user.click(screen.getByRole("button", { name: "Delete rubric" }));
    expect(screen.getByRole("heading", { name: "Delete rubric" })).toBeInTheDocument();
    expect(screen.getByText(/will be permanently deleted/)).toBeInTheDocument();

    const deleteButton = screen.getByRole("button", { name: "Delete" });
    await user.click(deleteButton);
    // First click just escalates the confirmation copy — no call yet.
    expect(mockDeleteRubric).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete forever?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete forever?" }));
    expect(mockDeleteRubric).toHaveBeenCalledWith(target.id);
    // The confirm dialog closes once the delete resolves.
    expect(screen.queryByText("This action cannot be undone.")).not.toBeInTheDocument();
  });

  it("cancels without calling deleteRubric", async () => {
    const user = userEvent.setup();
    render(
      <RubricsPanel rubrics={[target]} selectedId={null} onSelect={onSelect} canWrite />,
    );

    await user.click(screen.getByRole("button", { name: "Delete rubric" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockDeleteRubric).not.toHaveBeenCalled();
    expect(screen.queryByText("This action cannot be undone.")).not.toBeInTheDocument();
  });
});

describe("RubricsPanel — onboarding coach-mark (#331)", () => {
  it("shows the createRubric coach-mark when it's the active onboarding step", () => {
    render(
      <OnboardingProvider
        data={{ rubricCount: 0, runCount: 0, providerKeyCount: 0 }}
        canWrite
      >
        <RubricsPanel rubrics={[]} selectedId={null} onSelect={onSelect} canWrite />
      </OnboardingProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Create your first rubric" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This is where you create rubrics/),
    ).toBeInTheDocument();
  });

  it("does not show the coach-mark once the rubric step is satisfied", () => {
    render(
      <OnboardingProvider
        data={{ rubricCount: 1, runCount: 0, providerKeyCount: 0 }}
        canWrite
      >
        <RubricsPanel
          rubrics={[rubric()]}
          selectedId={null}
          onSelect={onSelect}
          canWrite
        />
      </OnboardingProvider>,
    );

    expect(
      screen.queryByText(/This is where you create rubrics/),
    ).not.toBeInTheDocument();
  });
});
