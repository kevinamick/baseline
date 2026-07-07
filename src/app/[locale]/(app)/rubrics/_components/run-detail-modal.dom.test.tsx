// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { RunDetailModal } from "./run-detail-modal";
import type { EvalRunDetails } from "@/types/eval-run";
import enMessages from "../../../../../../messages/en.json";

const mockGetEvalRunDetails = vi.fn();

vi.mock("@/app/actions/eval-runs", () => ({
  getEvalRunDetails: (...args: unknown[]) => mockGetEvalRunDetails(...args),
}));

// Two rows, two criteria each (results arrive flat and out of row order on
// purpose, so the grouping + sort in buildRowViews is exercised).
const DETAILS_FIXTURE: EvalRunDetails = {
  id: "run_1",
  rubricId: "rubric_1",
  status: "completed",
  evalType: "tabular",
  description: "Smoke run",
  notificationEmails: [],
  overallScore: 0.65,
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00Z",
  results: [
    { rowIndex: 1, criterionName: "Tone", score: 0.6, reasoning: "R1 tone." },
    { rowIndex: 0, criterionName: "Accuracy", score: 0.9, reasoning: "R0 accuracy." },
    { rowIndex: 0, criterionName: "Tone", score: 0.7, reasoning: "R0 tone." },
    { rowIndex: 1, criterionName: "Accuracy", score: 0.4, reasoning: "R1 accuracy." },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEvalRunDetails.mockResolvedValue(DETAILS_FIXTURE);
});

function renderModal(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe("RunDetailModal", () => {
  it("groups results into sorted per-row rows with correct averages", async () => {
    renderModal(<RunDetailModal runId="run_1" onClose={() => {}} />);

    // Row buttons appear once details resolve, one per distinct rowIndex.
    expect(await screen.findByText("Row 1")).toBeInTheDocument();
    expect(screen.getByText("Row 2")).toBeInTheDocument();
    expect(screen.getByText("Rows scored").nextSibling).toHaveTextContent("2");

    // Row 1 (rowIndex 0): avg of 0.9 and 0.7 = 0.8 -> 80%.
    expect(screen.getByText("80%")).toBeInTheDocument();
    // Row 2 (rowIndex 1): avg of 0.6 and 0.4 = 0.5 -> 50%.
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("reveals per-criterion detail only for the toggled row", async () => {
    const user = userEvent.setup();
    renderModal(<RunDetailModal runId="run_1" onClose={() => {}} />);

    const row1 = await screen.findByText("Row 1");
    // Collapsed: no criterion reasoning visible yet.
    expect(screen.queryByText("R0 accuracy.")).not.toBeInTheDocument();

    await user.click(row1);
    expect(screen.getByText("R0 accuracy.")).toBeInTheDocument();
    expect(screen.getByText("R0 tone.")).toBeInTheDocument();
    // Other row stays collapsed.
    expect(screen.queryByText("R1 accuracy.")).not.toBeInTheDocument();

    // Toggling closed hides it again.
    await user.click(row1);
    await waitFor(() =>
      expect(screen.queryByText("R0 accuracy.")).not.toBeInTheDocument()
    );
  });
});
