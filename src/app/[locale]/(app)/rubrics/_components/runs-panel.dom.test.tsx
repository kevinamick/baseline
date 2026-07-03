// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { RunsPanel } from "./runs-panel";
import { OnboardingProvider } from "./onboarding/onboarding-context";
import type { EvalRun } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";
import enMessages from "../../../../../../messages/en.json";

// See onboarding/__tests__/eval-onboarding.dom.test.tsx for the exhaustive
// coach-mark / "guided first run" state-machine coverage (active vs inactive,
// the doneTitle/doneMark swap, and the no-replay-for-a-later-run guarantee).
// This file focuses on the rest of RunsPanel: run-list rendering, statuses,
// compare mode, and wiring into the detail/comparison modals — plus a couple
// of coach-mark smoke tests so this file isn't blind to that surface either.

const getEvalRuns = vi.fn();

// Distinct ids per submit so multiple creates in one test are distinguishable.
const h = vi.hoisted(() => ({ createCount: 0 }));

vi.mock("@/app/actions/eval-runs", () => ({
  getEvalRuns: (...args: unknown[]) => getEvalRuns(...args),
}));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));

vi.mock("./run-detail-modal", () => ({
  RunDetailModal: ({ runId, onClose }: { runId: string; onClose: () => void }) => (
    <div data-testid="run-detail-modal">
      detail:{runId}
      <button onClick={onClose}>close detail</button>
    </div>
  ),
}));

vi.mock("./run-comparison-modal", () => ({
  RunComparisonModal: ({
    runIdA,
    runIdB,
    onClose,
  }: {
    runIdA: string;
    runIdB: string;
    onClose: () => void;
  }) => (
    <div data-testid="run-comparison-modal">
      compare:{runIdA}-{runIdB}
      <button onClick={onClose}>close compare</button>
    </div>
  ),
}));

// Stands in for the real Run Eval dialog (reused elsewhere, not rebuilt here).
// Clicking "submit" reports a freshly-created queued run via onCreated, the
// same shape the real dialog emits on submit.
vi.mock("./run-eval-dialog", () => ({
  RunEvalDialog: ({
    onCreated,
    onClose,
  }: {
    onCreated: (run: EvalRun) => void;
    onClose: () => void;
  }) => (
    <div data-testid="run-eval-dialog">
      <button
        data-testid="mock-submit-run"
        onClick={() => {
          h.createCount += 1;
          onCreated({
            id: `run-${h.createCount}`,
            rubricId: "1",
            status: "queued",
            evalType: "manual",
            description: null,
            notificationEmails: [],
            overallScore: null,
            errorMessage: null,
            createdAt: "2026-01-04T00:00:00Z",
          });
          // The real dialog closes itself on successful submit.
          onClose();
        }}
      >
        submit
      </button>
      <button onClick={onClose}>close dialog</button>
    </div>
  ),
}));

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

const RUBRIC: RubricSummary = {
  id: "1",
  name: "Support reply quality",
  evaluation_mode: "conversational",
  created_at: "2026-01-03T00:00:00Z",
};
const RUBRICS: RubricSummary[] = [RUBRIC];

function run(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: "run-a",
    rubricId: "1",
    status: "completed",
    evalType: "manual",
    description: null,
    notificationEmails: [],
    overallScore: 0.92,
    errorMessage: null,
    createdAt: "2026-01-03T12:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  h.createCount = 0;
  getEvalRuns.mockReset();
  getEvalRuns.mockResolvedValue([]);
});

describe("RunsPanel — empty / loading / selection states", () => {
  it("shows the select-a-rubric empty state and never fetches when nothing is selected", async () => {
    render(<RunsPanel selectedRubricId={null} rubrics={RUBRICS} canWrite />);

    expect(screen.getByText("Select a rubric")).toBeInTheDocument();
    expect(
      screen.getByText("Choose a rubric from the list to view its eval runs"),
    ).toBeInTheDocument();
    await waitFor(() => expect(getEvalRuns).not.toHaveBeenCalled());
  });

  it("shows a loading state while the initial fetch is in flight", async () => {
    let resolveRuns!: (runs: EvalRun[]) => void;
    getEvalRuns.mockReturnValue(
      new Promise<EvalRun[]>((resolve) => {
        resolveRuns = resolve;
      }),
    );

    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    resolveRuns([]);
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  });

  it("shows the no-runs empty state with a Run Eval prompt for writers", async () => {
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText("Run your first eval")).toBeInTheDocument();
  });

  it("hides the Run Eval prompt in the empty state for read-only members", async () => {
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite={false} />);

    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(screen.queryByText("Run your first eval")).not.toBeInTheDocument();
    // No Run Eval control in the header either.
    expect(screen.queryByRole("button", { name: /Run eval/i })).not.toBeInTheDocument();
  });

  it("shows the selected rubric's name as a breadcrumb and a mobile Back control", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <RunsPanel
        selectedRubricId="1"
        rubrics={RUBRICS}
        canWrite
        onBack={onBack}
      />,
    );

    expect(await screen.findByText("Support reply quality")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to rubrics" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("RunsPanel — run list rendering", () => {
  it("renders completed and failed runs with status badges and scores", async () => {
    getEvalRuns.mockResolvedValue([
      run({ id: "run-1", status: "completed", overallScore: 0.91, description: "Nightly check" }),
      run({ id: "run-2", status: "failed", overallScore: null, description: "Broken run" }),
    ]);

    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(await screen.findByText("Nightly check")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();

    expect(screen.getByText("Broken run")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // No score: renders the em-dash placeholder instead of a percentage.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders an in-progress run as the focused ActiveRunCard, separate from the list", async () => {
    getEvalRuns.mockResolvedValue([
      run({ id: "run-active", status: "running", overallScore: null, description: "Live run" }),
      run({ id: "run-done", status: "completed", overallScore: 0.5 }),
    ]);

    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(await screen.findByText("Now running")).toBeInTheDocument();
    // "Running" appears both as the ActiveRunCard's pill and (were it in the
    // list) a StatusBadge — but the active run is excluded from the row list.
    const runningBadges = screen.getAllByText("Running");
    expect(runningBadges).toHaveLength(1);
    expect(screen.getByText("Scoring rows…")).toBeInTheDocument();
    expect(screen.getByText("Live run")).toBeInTheDocument();
  });

  it("labels a queued active run as waiting for a worker", async () => {
    getEvalRuns.mockResolvedValue([run({ id: "run-q", status: "queued", overallScore: null })]);

    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(await screen.findByText("Now queued")).toBeInTheDocument();
    expect(screen.getByText("Waiting for a worker…")).toBeInTheDocument();
  });

  it("shows the retention window note once runs are present", async () => {
    getEvalRuns.mockResolvedValue([run()]);
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(
      await screen.findByText(/your plan.s retention window/i),
    ).toBeInTheDocument();
  });

  it("opens the detail modal for a completed run and closes it", async () => {
    getEvalRuns.mockResolvedValue([run({ id: "run-1", description: "Nightly check" })]);
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await user.click(await screen.findByText("Nightly check"));
    expect(screen.getByTestId("run-detail-modal")).toHaveTextContent("detail:run-1");

    await user.click(screen.getByText("close detail"));
    expect(screen.queryByTestId("run-detail-modal")).not.toBeInTheDocument();
  });

  it("does not open a detail modal for a queued/running row (not yet openable)", async () => {
    getEvalRuns.mockResolvedValue([run({ id: "run-q", status: "queued", overallScore: null })]);
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    // The active run renders only as the ActiveRunCard (not a clickable row).
    await screen.findByText("Now queued");
    expect(screen.queryByTestId("run-detail-modal")).not.toBeInTheDocument();
  });
});

describe("RunsPanel — Run Eval dialog", () => {
  it("opens the Run Eval dialog and adds the created run to the top of the list", async () => {
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await user.click(await screen.findByRole("button", { name: /Run eval/i }));
    expect(screen.getByTestId("run-eval-dialog")).toBeInTheDocument();

    await user.click(screen.getByTestId("mock-submit-run"));
    // The dialog closes on create and the new (queued) run becomes the active card.
    expect(screen.queryByTestId("run-eval-dialog")).not.toBeInTheDocument();
    expect(await screen.findByText("Now queued")).toBeInTheDocument();
  });

  it("also opens the dialog from the empty state's Run your first eval link", async () => {
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await user.click(await screen.findByText("Run your first eval"));
    expect(screen.getByTestId("run-eval-dialog")).toBeInTheDocument();
  });
});

describe("RunsPanel — fetch lifecycle", () => {
  it("polls for updates every 5s while a run stays active", async () => {
    getEvalRuns.mockResolvedValue([
      run({ id: "run-active", status: "running", overallScore: null }),
    ]);
    vi.useFakeTimers();
    try {
      render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);
      // Flush the initial fetch's promise chain (fake timers don't fake
      // microtasks, but `advanceTimersByTimeAsync` also drains them).
      await vi.advanceTimersByTimeAsync(0);
      expect(getEvalRuns).toHaveBeenCalledTimes(1);

      // POLL_INTERVAL_MS in runs-panel.tsx.
      await vi.advanceTimersByTimeAsync(5000);
      expect(getEvalRuns).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the loading state without crashing when the initial fetch fails", async () => {
    getEvalRuns.mockRejectedValue(new Error("boom"));
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });
});

describe("RunsPanel — compare mode", () => {
  function twoComparableRuns() {
    return [
      run({ id: "run-1", status: "completed", description: "Run one" }),
      run({ id: "run-2", status: "failed", description: "Run two", overallScore: null }),
    ];
  }

  it("hides the Compare control with fewer than 2 completed/failed runs", async () => {
    getEvalRuns.mockResolvedValue([
      run({ id: "run-1", status: "completed", description: "Solo run" }),
    ]);
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await screen.findByText("Solo run");
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
  });

  it("walks the full compare flow: enter, select two, open comparison, close", async () => {
    getEvalRuns.mockResolvedValue(twoComparableRuns());
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await screen.findByText("Run one");
    await user.click(screen.getByRole("button", { name: "Compare" }));

    // Header switches to selection-count copy; body rows become checkboxes.
    expect(screen.getByText("Select 2 runs")).toBeInTheDocument();

    await user.click(screen.getByText("Run one"));
    expect(screen.getByText("Select 1 more")).toBeInTheDocument();

    await user.click(screen.getByText("Run two"));
    expect(screen.getByText("2 runs selected")).toBeInTheDocument();

    // The header's own Compare (act on selection) button appears once 2 are picked.
    const compareButtons = screen.getAllByRole("button", { name: "Compare" });
    expect(compareButtons).toHaveLength(1);
    await user.click(compareButtons[0]);

    expect(screen.getByTestId("run-comparison-modal")).toHaveTextContent(
      "compare:run-1-run-2",
    );
    await user.click(screen.getByText("close compare"));
    expect(screen.queryByTestId("run-comparison-modal")).not.toBeInTheDocument();
  });

  it("swaps the oldest selection when a third run is picked", async () => {
    getEvalRuns.mockResolvedValue([
      ...twoComparableRuns(),
      run({ id: "run-3", status: "completed", description: "Run three" }),
    ]);
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await screen.findByText("Run one");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    await user.click(screen.getByText("Run one"));
    await user.click(screen.getByText("Run two"));
    // Third pick bumps the first ("Run one") out in favor of "Run three".
    await user.click(screen.getByText("Run three"));
    expect(screen.getByText("2 runs selected")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Compare" })[0]);
    expect(screen.getByTestId("run-comparison-modal")).toHaveTextContent(
      "compare:run-2-run-3",
    );
  });

  it("toggling a selected run off removes it from the selection", async () => {
    getEvalRuns.mockResolvedValue(twoComparableRuns());
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await screen.findByText("Run one");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    await user.click(screen.getByText("Run one"));
    expect(screen.getByText("Select 1 more")).toBeInTheDocument();

    await user.click(screen.getByText("Run one"));
    expect(screen.getByText("Select 2 runs")).toBeInTheDocument();
  });

  it("cancels out of compare mode via the header Cancel control", async () => {
    getEvalRuns.mockResolvedValue(twoComparableRuns());
    const user = userEvent.setup();
    render(<RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />);

    await screen.findByText("Run one");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    await user.click(screen.getByText("Run one"));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // Back to the normal header; the Compare entry control returns.
    expect(screen.getByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(screen.queryByText("Select 1 more")).not.toBeInTheDocument();
  });

  it("resets compare mode when the selected rubric changes", async () => {
    const rubricTwo: RubricSummary = { ...RUBRIC, id: "2", name: "Second rubric" };
    getEvalRuns.mockResolvedValue(twoComparableRuns());
    const user = userEvent.setup();
    const { rerender } = render(
      <RunsPanel selectedRubricId="1" rubrics={[RUBRIC, rubricTwo]} canWrite />,
    );

    await screen.findByText("Run one");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByText("Select 2 runs")).toBeInTheDocument();

    getEvalRuns.mockResolvedValue([]);
    rerender(<RunsPanel selectedRubricId="2" rubrics={[RUBRIC, rubricTwo]} canWrite />);

    await screen.findByText("Second rubric");
    // Compare mode UI is gone; back to the normal (non-selection) header.
    expect(screen.queryByText("Select 2 runs")).not.toBeInTheDocument();
  });
});

describe("RunsPanel — guided-tutorial coach-mark (smoke)", () => {
  // Full state-machine coverage (doneTitle/doneMark swap, no-replay guarantee)
  // lives in onboarding/__tests__/eval-onboarding.dom.test.tsx; these two tests
  // just confirm the wiring from this file's perspective.
  it("shows the Run Eval coach-mark when the tutorial's eval step is active", async () => {
    render(
      <OnboardingProvider data={{ rubricCount: 1, runCount: 0, providerKeyCount: 1 }} canWrite>
        <RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />
      </OnboardingProvider>,
    );

    expect(await screen.findByTestId("coach-mark")).toBeInTheDocument();
    expect(screen.getByText("Run your first evaluation")).toBeInTheDocument();
  });

  it("shows no coach-mark once the eval step is already satisfied", async () => {
    render(
      <OnboardingProvider data={{ rubricCount: 1, runCount: 1, providerKeyCount: 1 }} canWrite>
        <RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />
      </OnboardingProvider>,
    );

    await waitFor(() => expect(getEvalRuns).toHaveBeenCalled());
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
  });

  it("captures the guided first run's id on create and shows the done confirmation", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingProvider data={{ rubricCount: 1, runCount: 0, providerKeyCount: 1 }} canWrite>
        <RunsPanel selectedRubricId="1" rubrics={RUBRICS} canWrite />
      </OnboardingProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /Run eval/i }));
    await user.click(screen.getByTestId("mock-submit-run"));

    expect(await screen.findByText("Your eval is running")).toBeInTheDocument();
  });
});
