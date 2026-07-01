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

// A hoisted counter lets the mocked dialog emit a distinct run id per submit, so
// a test can create a first guided run and then a second run.
const h = vi.hoisted(() => ({ createCount: 0 }));

vi.mock("@/app/actions/eval-runs", () => ({
  getEvalRuns: (...args: unknown[]) => getEvalRuns(...args),
}));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));
vi.mock("../../run-detail-modal", () => ({ RunDetailModal: () => null }));
vi.mock("../../run-comparison-modal", () => ({ RunComparisonModal: () => null }));

// The Run Eval dialog stands in for the real one (reused, not rebuilt). Clicking
// its button reports a freshly-created queued run via onCreated — a distinct id
// each time — the same shape the real dialog emits on submit.
vi.mock("../../run-eval-dialog", () => ({
  RunEvalDialog: ({ onCreated }: { onCreated: (run: EvalRun) => void }) => (
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
      }}
    >
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

function Panel({
  selectedRubricId,
  runCount,
  canWrite = true,
}: {
  selectedRubricId: string | null;
  runCount: number;
  canWrite?: boolean;
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OnboardingProvider data={{ rubricCount: 1, runCount }} canWrite={canWrite}>
        <RunsPanel
          selectedRubricId={selectedRubricId}
          rubrics={ONE_RUBRIC}
          canWrite={canWrite}
        />
      </OnboardingProvider>
    </NextIntlClientProvider>
  );
}

describe("Guided eval step on /rubrics runs panel", () => {
  beforeEach(() => {
    h.createCount = 0;
    getEvalRuns.mockReset();
    getEvalRuns.mockResolvedValue([]);
  });

  it("pins the eval coach-mark to the Run Eval control once a rubric is selected", async () => {
    render(<Panel selectedRubricId="1" runCount={0} />);

    expect(await screen.findByTestId("coach-mark")).toBeInTheDocument();
    expect(
      screen.getByText(/Now run your first evaluation/i),
    ).toBeInTheDocument();
  });

  it("shows no eval coach-mark until a rubric is selected (control off-screen)", async () => {
    render(<Panel selectedRubricId={null} runCount={0} />);

    // The select-a-rubric empty state renders; the Run Eval control and its
    // coach-mark only appear once a rubric is picked (auto-selected on create).
    await waitFor(() => expect(getEvalRuns).not.toHaveBeenCalled());
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Now run your first evaluation/i),
    ).not.toBeInTheDocument();
  });

  it("drops the eval coach-mark once the Team already has a run (tutorial complete)", async () => {
    render(<Panel selectedRubricId="1" runCount={1} />);

    // Let the initial fetch settle so a late coach-mark would have appeared.
    await waitFor(() => expect(getEvalRuns).toHaveBeenCalled());
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Now run your first evaluation/i),
    ).not.toBeInTheDocument();
  });

  it("swaps to the final coach-mark on the runs panel when the first eval is created", async () => {
    const user = userEvent.setup();
    render(<Panel selectedRubricId="1" runCount={0} />);

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

  it("does not replay the confirmation for a later run (keyed to the first run's id)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Panel selectedRubricId="1" runCount={0} />);

    // Create the guided first run — the confirmation appears.
    await user.click(await screen.findByRole("button", { name: /Run Eval/i }));
    await user.click(screen.getByTestId("mock-submit-run"));
    expect(
      await screen.findByText(/Results will appear here/i),
    ).toBeInTheDocument();

    // Revalidation flips the eval step satisfied (the tutorial is complete).
    rerender(<Panel selectedRubricId="1" runCount={1} />);

    // A second run is created later in the same session. It becomes the newest
    // active run, but the confirmation is keyed to the first run's id, so it does
    // NOT reappear — no replay.
    await user.click(screen.getByRole("button", { name: /Run Eval/i }));
    await user.click(screen.getByTestId("mock-submit-run"));
    expect(
      screen.queryByText(/Results will appear here/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Now run your first evaluation/i),
    ).not.toBeInTheDocument();
  });
});
