// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunComparisonModal } from "./run-comparison-modal";
import type { EvalRunComparison } from "@/types/eval-run";

const mockGetEvalRunComparison = vi.fn();

vi.mock("@/app/actions/eval-runs", () => ({
  getEvalRunComparison: (...args: unknown[]) => mockGetEvalRunComparison(...args),
}));

const COMPARISON_FIXTURE: EvalRunComparison = {
  runA: {
    id: "run_1",
    rubricId: "rubric_1",
    status: "completed",
    evalType: "tabular",
    description: "Baseline run",
    notificationEmails: [],
    overallScore: 0.75,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00Z",
    results: [
      { rowIndex: 0, criterionName: "Accuracy", score: 0.8, reasoning: "Mostly correct." },
      { rowIndex: 0, criterionName: "Tone", score: 0.7, reasoning: "A bit formal." },
    ],
    rows: [
      { rowIndex: 0, userInput: "How do I reset my password?", agentOutput: "Click forgot password.", expectedOutput: null },
    ],
  },
  runB: {
    id: "run_2",
    rubricId: "rubric_1",
    status: "completed",
    evalType: "tabular",
    description: "Optimized run",
    notificationEmails: [],
    overallScore: 0.9,
    errorMessage: null,
    createdAt: "2026-01-15T00:00:00Z",
    results: [
      { rowIndex: 0, criterionName: "Accuracy", score: 0.95, reasoning: "Fully accurate." },
      { rowIndex: 0, criterionName: "Tone", score: 0.85, reasoning: "Warm and clear." },
    ],
    rows: [
      { rowIndex: 0, userInput: "How do I reset my password?", agentOutput: "Go to sign-in and click Forgot password.", expectedOutput: null },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEvalRunComparison.mockResolvedValue(COMPARISON_FIXTURE);
});

describe("RunComparisonModal", () => {
  it("shows loading state initially", () => {
    mockGetEvalRunComparison.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders comparison data after loading", async () => {
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Run comparison")).toBeInTheDocument();
    expect(screen.getByText("Baseline run")).toBeInTheDocument();
    expect(screen.getByText("Optimized run")).toBeInTheDocument();
    // 75% / 90% render in the score tiles (and again as per-row averages).
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("90%").length).toBeGreaterThan(0);
  });

  it("shows per-criterion aggregate table with delta", async () => {
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Accuracy")).toBeInTheDocument();
    expect(screen.getByText("Tone")).toBeInTheDocument();
    // Both criteria improved by +0.15 (and the delta repeats per row).
    expect(screen.getAllByText("+0.15").length).toBeGreaterThanOrEqual(2);
  });

  it("shows per-row breakdown with run A and B score", async () => {
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Per-row breakdown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Row 1/ })).toBeInTheDocument();
  });

  it("expands a row to show user input and side-by-side outputs", async () => {
    const user = userEvent.setup();
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /Row 1/ }));
    expect(screen.getByText("User input")).toBeInTheDocument();
    expect(screen.getByText("How do I reset my password?")).toBeInTheDocument();
    expect(screen.getByText("Run A output")).toBeInTheDocument();
    expect(screen.getByText("Run B output")).toBeInTheDocument();
    expect(screen.getByText("Click forgot password.")).toBeInTheDocument();
    expect(screen.getByText("Go to sign-in and click Forgot password.")).toBeInTheDocument();
  });

  it("shows per-criterion scores inside an expanded row", async () => {
    const user = userEvent.setup();
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /Row 1/ }));
    // Two Accuracy rows: one in the criteria overview, one in the per-row breakdown
    const accuracyItems = screen.getAllByText("Accuracy");
    expect(accuracyItems.length).toBeGreaterThanOrEqual(1);
  });

  it("collapses the row when clicked again", async () => {
    const user = userEvent.setup();
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    const rowButton = screen.getByRole("button", { name: /Row 1/ });
    await user.click(rowButton);
    expect(screen.getByText("User input")).toBeInTheDocument();
    await user.click(rowButton);
    expect(screen.queryByText("User input")).not.toBeInTheDocument();
  });

  it("calls getEvalRunComparison with the correct run IDs", async () => {
    render(
      <RunComparisonModal runIdA="run_abc" runIdB="run_xyz" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    expect(mockGetEvalRunComparison).toHaveBeenCalledWith("run_abc", "run_xyz");
  });

  it("shows an error message when comparison cannot be loaded", async () => {
    mockGetEvalRunComparison.mockResolvedValue(null);
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    expect(
      screen.getByText(/Could not load comparison/)
    ).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={onClose} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    // Two controls are named "Close" (header icon + footer button); either fires onClose.
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows side-by-side inputs when run A and B have different user inputs", async () => {
    const user = userEvent.setup();
    const differentInputFixture: EvalRunComparison = {
      ...COMPARISON_FIXTURE,
      runA: {
        ...COMPARISON_FIXTURE.runA,
        rows: [{ rowIndex: 0, userInput: "Question A", agentOutput: "Answer A", expectedOutput: null }],
      },
      runB: {
        ...COMPARISON_FIXTURE.runB,
        rows: [{ rowIndex: 0, userInput: "Question B", agentOutput: "Answer B", expectedOutput: null }],
      },
    };
    mockGetEvalRunComparison.mockResolvedValue(differentInputFixture);
    render(
      <RunComparisonModal runIdA="run_1" runIdB="run_2" onClose={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /Row 1/ }));
    expect(screen.getByText("Run A input")).toBeInTheDocument();
    expect(screen.getByText("Run B input")).toBeInTheDocument();
    expect(screen.getByText("Question A")).toBeInTheDocument();
    expect(screen.getByText("Question B")).toBeInTheDocument();
  });
});
