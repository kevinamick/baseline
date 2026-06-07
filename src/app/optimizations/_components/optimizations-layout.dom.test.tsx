// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizationsLayout } from "./optimizations-layout";
import type { OptimizationRunSummary } from "@/types/optimization";

const mockReplace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => searchParams,
}));

const mockGetOptimizationRun = vi.fn();
vi.mock("@/app/actions/optimizations", () => ({
  getOptimizationRun: (id: string) => mockGetOptimizationRun(id),
}));

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
});

describe("OptimizationsLayout", () => {
  it("lists runs by connection name", () => {
    render(<OptimizationsLayout runs={RUNS} canWrite />);
    expect(screen.getByText("Support Agent", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Billing Agent")).toBeInTheDocument();
  });

  it("shows an empty state when there are no runs", () => {
    render(<OptimizationsLayout runs={[]} canWrite={false} />);
    expect(screen.getByText("No optimization runs yet.")).toBeInTheDocument();
  });

  it("reflects a clicked run in the URL via ?run=<id>", async () => {
    const user = userEvent.setup();
    render(<OptimizationsLayout runs={RUNS} canWrite />);
    await user.click(screen.getByText("Billing Agent"));
    expect(mockReplace).toHaveBeenCalledWith("/optimizations?run=run-b", { scroll: false });
  });

  it("opens the run named by ?run=<id> on load", async () => {
    searchParams = new URLSearchParams("run=run-b");
    render(<OptimizationsLayout runs={RUNS} canWrite />);
    // The detail loads via getOptimizationRun for the addressed run.
    expect(mockGetOptimizationRun).toHaveBeenCalledWith("run-b");
    expect(await screen.findByText("Rollout budget")).toBeInTheDocument();
  });

  it("shows the score lift and a per-Module optimized prompt with copy on a completed run", async () => {
    searchParams = new URLSearchParams("run=run-a");
    render(<OptimizationsLayout runs={RUNS} canWrite />);

    expect(await screen.findByText("Score lift")).toBeInTheDocument();
    // Both the seed and optimized prompt are shown (the diff), and the optimized text is copyable.
    expect(screen.getByText("seed prompt text")).toBeInTheDocument();
    expect(screen.getByText("optimized prompt text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    // The best score appears (lift headline + config strip + list row).
    expect(screen.getAllByText(/0\.81/).length).toBeGreaterThan(0);
  });
});
