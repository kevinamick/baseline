// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScoreWithTooltip } from "./score-with-tooltip";

// Mock the server action so DOM tests don't make network calls.
vi.mock("@/app/actions/eval-runs", () => ({
  getRunCriteriaBreakdown: vi.fn(),
}));

import { getRunCriteriaBreakdown } from "@/app/actions/eval-runs";

const mockGetRunCriteriaBreakdown = getRunCriteriaBreakdown as ReturnType<typeof vi.fn>;

const CRITERIA = [
  { name: "Accuracy", score: 0.9 },
  { name: "Tone", score: 0.4 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRunCriteriaBreakdown.mockResolvedValue(CRITERIA);
});

describe("ScoreWithTooltip", () => {
  it("renders children without tooltip initially", () => {
    render(
      <ScoreWithTooltip criteria={CRITERIA}>
        <span>90%</span>
      </ScoreWithTooltip>,
    );
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows tooltip with pre-loaded criteria on hover", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip criteria={CRITERIA}>
        <span>90%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("90%"));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent("Accuracy");
    expect(tooltip).toHaveTextContent("90%");
    expect(tooltip).toHaveTextContent("Tone");
    expect(tooltip).toHaveTextContent("40%");
  });

  it("hides tooltip when mouse leaves", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip criteria={CRITERIA}>
        <span>90%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("90%"));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    // Once open, the tooltip's "Accuracy: 90%" criterion adds a second "90%"
    // match — disambiguate to the trigger (rendered first, index 0).
    await user.unhover(screen.getAllByText("90%")[0]);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("lazy-fetches criteria on hover when only runId is provided", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip runId="run_123">
        <span>75%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("75%"));

    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    expect(mockGetRunCriteriaBreakdown).toHaveBeenCalledWith("run_123");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Accuracy");
  });

  it("does not fetch again on subsequent hover after initial load", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip runId="run_123">
        <span>75%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("75%"));
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    await user.unhover(screen.getByText("75%"));

    await user.hover(screen.getByText("75%"));
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());

    expect(mockGetRunCriteriaBreakdown).toHaveBeenCalledTimes(1);
  });

  it("does not show tooltip when no criteria and no runId", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip>
        <span>50%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("50%"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not show tooltip when empty criteria array", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip criteria={[]}>
        <span>50%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("50%"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("applies correct color class for high scores (≥80%)", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip criteria={[{ name: "Accuracy", score: 0.9 }]}>
        <span>90%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("90%"));
    const tooltip = screen.getByRole("tooltip");
    const criteriaScore = tooltip.querySelector(".text-success-fg");
    expect(criteriaScore).toBeInTheDocument();
    expect(criteriaScore).toHaveTextContent("90%");
  });

  it("applies correct color class for mid scores (50–79%)", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip criteria={[{ name: "Tone", score: 0.6 }]}>
        <span>60%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("60%"));
    const tooltip = screen.getByRole("tooltip");
    const criteriaScore = tooltip.querySelector(".text-warning-fg");
    expect(criteriaScore).toBeInTheDocument();
  });

  it("applies correct color class for low scores (<50%)", async () => {
    const user = userEvent.setup();
    render(
      <ScoreWithTooltip criteria={[{ name: "Tone", score: 0.3 }]}>
        <span>30%</span>
      </ScoreWithTooltip>,
    );

    await user.hover(screen.getByText("30%"));
    const tooltip = screen.getByRole("tooltip");
    const criteriaScore = tooltip.querySelector(".text-danger-fg");
    expect(criteriaScore).toBeInTheDocument();
  });
});
