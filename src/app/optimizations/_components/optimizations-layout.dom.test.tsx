// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizationsLayout } from "./optimizations-layout";
import type { OptimizationRunSummary } from "@/types/optimization";
import type { RubricSummary } from "@/types/rubric";

const mockReplace = vi.fn();
const mockRefresh = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
  useSearchParams: () => searchParams,
}));

const mockGetOptimizationRun = vi.fn();
const mockStartOptimizationRun = vi.fn();
const mockCancelOptimizationRun = vi.fn();
vi.mock("@/app/actions/optimizations", () => ({
  getOptimizationRun: (id: string) => mockGetOptimizationRun(id),
  startOptimizationRun: (input: unknown) => mockStartOptimizationRun(input),
  cancelOptimizationRun: (id: string) => mockCancelOptimizationRun(id),
}));

const RUBRIC: RubricSummary = {
  id: "rub-1",
  name: "Helpfulness",
  evaluation_mode: "prompt_response",
  created_at: "2026-06-01T00:00:00Z",
};

// A running detail for the selected run — drives the in-progress treatment (progress + Cancel).
function runningDetail(id: string) {
  return {
    run: {
      id,
      status: "running",
      created_at: "2026-06-02T00:00:00Z",
      budget_rollouts: 50,
      max_iters: 20,
      plateau_patience: null,
      reflect_model: "claude-sonnet-4-6",
      best_score: null,
      best_candidate_id: null,
      error_message: null,
      connections: { name: "Billing Agent" },
      rubrics: { name: "Accuracy" },
    },
    instanceCount: 6,
    candidateCount: 2,
    rolloutsSpent: 11,
    seedScore: null,
    seedPrompts: { main: "seed" },
    winningPrompts: null,
  };
}

const RUNS: OptimizationRunSummary[] = [
  {
    id: "run-a",
    connection_name: "Support Agent",
    rubric_name: "Helpfulness",
    status: "completed",
    best_score: 0.81,
    seed_score: 0.62,
    created_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "run-b",
    connection_name: "Billing Agent",
    rubric_name: "Accuracy",
    status: "running",
    best_score: null,
    seed_score: null,
    created_at: "2026-06-02T00:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  // Echo the requested id back on the run so the layout's "detail matches selection" guard
  // is satisfied (it only renders detail whose id equals the selected run).
  mockGetOptimizationRun.mockImplementation((id: string) => Promise.resolve({
    run: {
      id,
      status: "completed",
      created_at: "2026-06-01T00:00:00Z",
      budget_rollouts: 50,
      max_iters: 20,
      plateau_patience: 5,
      reflect_model: "claude-sonnet-4-6",
      best_score: 0.81,
      best_candidate_id: "cand-win",
      connections: { name: "Support Agent" },
      rubrics: { name: "Helpfulness" },
    },
    instanceCount: 10,
    seedScore: 0.62,
    seedPrompts: { main: "seed prompt text" },
    winningPrompts: { main: "optimized prompt text" },
  }));
  mockCancelOptimizationRun.mockResolvedValue({ ok: true });
});

describe("OptimizationsLayout", () => {
  it("lists runs by connection name", () => {
    render(<OptimizationsLayout runs={RUNS} rubrics={[]} connections={[]} canWrite />);
    expect(screen.getByText("Support Agent", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Billing Agent")).toBeInTheDocument();
  });

  it("shows an empty state when there are no runs", () => {
    render(<OptimizationsLayout runs={[]} rubrics={[]} connections={[]} canWrite={false} />);
    expect(screen.getByText("No optimization runs yet.")).toBeInTheDocument();
  });

  it("reflects a clicked run in the URL via ?run=<id>", async () => {
    const user = userEvent.setup();
    render(<OptimizationsLayout runs={RUNS} rubrics={[]} connections={[]} canWrite />);
    await user.click(screen.getByText("Billing Agent"));
    expect(mockReplace).toHaveBeenCalledWith("/optimizations?run=run-b", { scroll: false });
  });

  it("opens the run named by ?run=<id> on load", async () => {
    searchParams = new URLSearchParams("run=run-b");
    render(<OptimizationsLayout runs={RUNS} rubrics={[]} connections={[]} canWrite />);
    // The detail loads via getOptimizationRun for the addressed run.
    expect(mockGetOptimizationRun).toHaveBeenCalledWith("run-b");
    expect(await screen.findByText("Rollout budget")).toBeInTheDocument();
  });

  it("shows the score lift and a per-Module optimized prompt with copy on a completed run", async () => {
    searchParams = new URLSearchParams("run=run-a");
    render(<OptimizationsLayout runs={RUNS} rubrics={[]} connections={[]} canWrite />);

    expect(await screen.findByText("Score lift")).toBeInTheDocument();
    // Both the seed and optimized prompt are shown (the diff), and the optimized text is copyable.
    expect(screen.getByText("seed prompt text")).toBeInTheDocument();
    expect(screen.getByText("optimized prompt text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    // The best score appears (lift headline + config strip + list row).
    expect(screen.getAllByText(/0\.81/).length).toBeGreaterThan(0);
  });

  it("shows derived progress (rollouts spent vs budget, candidate count) on a running run", async () => {
    searchParams = new URLSearchParams("run=run-b");
    mockGetOptimizationRun.mockImplementation((id: string) =>
      Promise.resolve({
        run: {
          id,
          status: "running",
          created_at: "2026-06-02T00:00:00Z",
          budget_rollouts: 50,
          max_iters: 20,
          plateau_patience: null,
          reflect_model: "claude-sonnet-4-6",
          best_score: null,
          best_candidate_id: null,
          error_message: null,
          connections: { name: "Billing Agent" },
          rubrics: { name: "Accuracy" },
        },
        instanceCount: 6,
        candidateCount: 3,
        rolloutsSpent: 17,
        seedScore: null,
        seedPrompts: { main: "seed prompt text" },
        winningPrompts: null,
      })
    );

    render(<OptimizationsLayout runs={RUNS} rubrics={[]} connections={[]} canWrite />);

    expect(await screen.findByText("Rollouts spent")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText("/ 50")).toBeInTheDocument();
    expect(screen.getByText("3 candidates discovered")).toBeInTheDocument();
    // No optimized-prompt diff on a non-completed run.
    expect(screen.queryByText("Optimized prompts")).not.toBeInTheDocument();
  });

  it("shows the failure reason verbatim and an honest no-prompt note on a failed run", async () => {
    searchParams = new URLSearchParams("run=run-b");
    mockGetOptimizationRun.mockImplementation((id: string) =>
      Promise.resolve({
        run: {
          id,
          status: "failed",
          created_at: "2026-06-02T00:00:00Z",
          budget_rollouts: 50,
          max_iters: 20,
          plateau_patience: null,
          reflect_model: "claude-sonnet-4-6",
          best_score: null,
          best_candidate_id: null,
          error_message: "Circuit breaker tripped: the agent endpoint failed on 3 consecutive iterations",
          connections: { name: "Billing Agent" },
          rubrics: { name: "Accuracy" },
        },
        instanceCount: 6,
        candidateCount: 1,
        rolloutsSpent: 4,
        seedScore: null,
        seedPrompts: { main: "seed prompt text" },
        winningPrompts: null,
      })
    );

    render(<OptimizationsLayout runs={RUNS} rubrics={[]} connections={[]} canWrite />);

    expect(await screen.findByText("Run failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Circuit breaker tripped: the agent endpoint failed on 3 consecutive iterations/)
    ).toBeInTheDocument();
    expect(screen.getByText("No optimized prompt was produced.")).toBeInTheDocument();
  });

  it("disables 'New run' with a note while a run is active", () => {
    // RUNS contains a running run, so the org's single active slot is taken.
    render(<OptimizationsLayout runs={RUNS} rubrics={[RUBRIC]} connections={[]} canWrite />);
    // The entry point is rendered non-interactively (a span, not a button).
    expect(screen.queryByRole("button", { name: "+ New run" })).not.toBeInTheDocument();
    expect(
      screen.getByText("An optimization run is already active — only one runs at a time.")
    ).toBeInTheDocument();
  });

  it("refreshes the list on an interval while a run is active (live pills + gate)", () => {
    vi.useFakeTimers();
    try {
      // RUNS has a running run → the server-rendered list must be refreshed to reflect a finish.
      render(<OptimizationsLayout runs={RUNS} rubrics={[RUBRIC]} connections={[]} canWrite />);
      expect(mockRefresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(4000);
      expect(mockRefresh).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh the list when no run is active", () => {
    vi.useFakeTimers();
    try {
      const settled = RUNS.map((r) => ({ ...r, status: "completed" as const }));
      render(<OptimizationsLayout runs={settled} rubrics={[RUBRIC]} connections={[]} canWrite />);
      vi.advanceTimersByTime(8000);
      expect(mockRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a running run through a confirm dialog that Escape can't dismiss", async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams("run=run-b");
    mockGetOptimizationRun.mockImplementation((id: string) => Promise.resolve(runningDetail(id)));

    render(<OptimizationsLayout runs={RUNS} rubrics={[RUBRIC]} connections={[]} canWrite />);

    // Open the confirm dialog from the running detail (the only "Cancel run" button so far).
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Cancel this optimization run?")).toBeInTheDocument();

    // Escape must NOT dismiss a destructive confirmation (guardrail).
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    // Confirming (the dialog's own button) calls the action with the selected run id.
    await user.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    expect(mockCancelOptimizationRun).toHaveBeenCalledWith("run-b");
  });

  it("dismisses the cancel dialog on 'Keep running' without cancelling", async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams("run=run-b");
    mockGetOptimizationRun.mockImplementation((id: string) => Promise.resolve(runningDetail(id)));

    render(<OptimizationsLayout runs={RUNS} rubrics={[RUBRIC]} connections={[]} canWrite />);

    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await user.click(screen.getByRole("button", { name: "Keep running" }));
    expect(screen.queryByText("Cancel this optimization run?")).not.toBeInTheDocument();
    expect(mockCancelOptimizationRun).not.toHaveBeenCalled();
  });

  it("hides the Cancel button for read-only members", async () => {
    searchParams = new URLSearchParams("run=run-b");
    mockGetOptimizationRun.mockImplementation((id: string) => Promise.resolve(runningDetail(id)));

    render(<OptimizationsLayout runs={RUNS} rubrics={[RUBRIC]} connections={[]} canWrite={false} />);

    expect(await screen.findByText("Rollouts spent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
  });
});
