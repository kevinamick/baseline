// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { OnboardingProvider } from "../onboarding-context";
import { RunsPanel } from "../../runs-panel";
import type { EvalRun } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";
import enMessages from "../../../../../../../../messages/en.json";

const getEvalRuns = vi.fn();

vi.mock("@/app/actions/eval-runs", () => ({
  getEvalRuns: (...args: unknown[]) => getEvalRuns(...args),
}));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));
vi.mock("../../run-detail-modal", () => ({ RunDetailModal: () => null }));
vi.mock("../../run-comparison-modal", () => ({ RunComparisonModal: () => null }));

// The Run Eval dialog stands in for the real one (reused, not rebuilt). Clicking
// its button reports a freshly-created queued run via onCreated, the same shape
// the real dialog emits on submit.
const CREATED_RUN: EvalRun = {
  id: "run-1",
  rubricId: "1",
  status: "queued",
  evalType: "manual",
  description: null,
  notificationEmails: [],
  overallScore: null,
  errorMessage: null,
  createdAt: "2026-01-04T00:00:00Z",
};
vi.mock("../../run-eval-dialog", () => ({
  RunEvalDialog: ({ onCreated }: { onCreated: (run: EvalRun) => void }) => (
    <button data-testid="mock-submit-run" onClick={() => onCreated(CREATED_RUN)}>
      submit
    </button>
  ),
}));

const ONE_RUBRIC: RubricSummary[] = [
  {
    id: "1",
    name: "Support reply quality",
    evaluation_mode: "conversational",
    created_at: "2026-01-03T00:00:00Z",
  },
];

function renderRunsPanel({
  selectedRubricId,
  runCount,
  canWrite = true,
}: {
  selectedRubricId: string | null;
  runCount: number;
  canWrite?: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OnboardingProvider data={{ rubricCount: 1, runCount }} canWrite={canWrite}>
        <RunsPanel
          selectedRubricId={selectedRubricId}
          rubrics={ONE_RUBRIC}
          canWrite={canWrite}
        />
      </OnboardingProvider>
    </NextIntlClientProvider>,
  );
}

describe("Guided eval step on /rubrics runs panel", () => {
  beforeEach(() => {
    getEvalRuns.mockReset();
    getEvalRuns.mockResolvedValue([]);
  });

  it("pins the eval coach-mark to the Run Eval control once a rubric is selected", async () => {
    renderRunsPanel({ selectedRubricId: "1", runCount: 0 });

    expect(await screen.findByTestId("coach-mark")).toBeInTheDocument();
    expect(
      screen.getByText(/Now run your first evaluation/i),
    ).toBeInTheDocument();
  });

  it("shows no eval coach-mark until a rubric is selected (control off-screen)", async () => {
    renderRunsPanel({ selectedRubricId: null, runCount: 0 });

    // The select-a-rubric empty state renders; the Run Eval control and its
    // coach-mark only appear once a rubric is picked (auto-selected on create).
    await waitFor(() => expect(getEvalRuns).not.toHaveBeenCalled());
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Now run your first evaluation/i),
    ).not.toBeInTheDocument();
  });

  it("drops the eval coach-mark once the Team already has a run (tutorial complete)", async () => {
    getEvalRuns.mockResolvedValue([]);
    renderRunsPanel({ selectedRubricId: "1", runCount: 1 });

    // Let the initial fetch settle so a late coach-mark would have appeared.
    await waitFor(() => expect(getEvalRuns).toHaveBeenCalled());
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Now run your first evaluation/i),
    ).not.toBeInTheDocument();
  });

  it("swaps to the final coach-mark on the runs panel when the first eval is created", async () => {
    const user = userEvent.setup();
    renderRunsPanel({ selectedRubricId: "1", runCount: 0 });

    // The Run Eval coach is showing.
    expect(
      await screen.findByText(/Now run your first evaluation/i),
    ).toBeInTheDocument();

    // Open the (reused) Run Eval dialog and submit the first run.
    await user.click(screen.getByRole("button", { name: /Run Eval/i }));
    await user.click(screen.getByTestId("mock-submit-run"));

    // The active coach moves off the control and onto the runs panel.
    expect(
      await screen.findByText(/Results will appear here/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Now run your first evaluation/i),
    ).not.toBeInTheDocument();
  });

  it("does not replay the running confirmation for a later run in the same session", async () => {
    const user = userEvent.setup();

    const tree = (
      selectedRubricId: string | null,
      runCount: number,
    ) => (
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <OnboardingProvider data={{ rubricCount: 1, runCount }} canWrite>
          <RunsPanel
            selectedRubricId={selectedRubricId}
            rubrics={ONE_RUBRIC}
            canWrite
          />
        </OnboardingProvider>
      </NextIntlClientProvider>
    );

    const { rerender } = render(tree("1", 0));

    // Create the first guided run — the confirmation coach appears.
    await user.click(await screen.findByRole("button", { name: /Run Eval/i }));
    await user.click(screen.getByTestId("mock-submit-run"));
    expect(
      await screen.findByText(/Results will appear here/i),
    ).toBeInTheDocument();

    // The run leaves the active view (mobile back to the rubrics list) while
    // revalidation completes the eval step (runCount → 1). The confirmation
    // self-dismisses; its flag must reset so it can't re-arm later.
    getEvalRuns.mockResolvedValue([
      { ...CREATED_RUN, status: "completed", overallScore: 0.9 },
    ]);
    rerender(tree(null, 1));
    await waitFor(() =>
      expect(
        screen.queryByText(/Results will appear here/i),
      ).not.toBeInTheDocument(),
    );

    // Reselect the rubric and create a second run later in the same session.
    rerender(tree("1", 1));
    await waitFor(() => expect(getEvalRuns).toHaveBeenCalledWith("1"));
    await user.click(screen.getByRole("button", { name: /Run Eval/i }));
    await user.click(screen.getByTestId("mock-submit-run"));

    // The eval step is already satisfied, so neither guided coach returns.
    await waitFor(() =>
      expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Results will appear here/i),
    ).not.toBeInTheDocument();
  });
});
