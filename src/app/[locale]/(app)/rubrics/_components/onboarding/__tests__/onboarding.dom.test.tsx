// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { OnboardingProvider } from "../onboarding-context";
import { GettingStartedCard } from "../getting-started-card";
import { RubricsPanel } from "../../rubrics-panel";
import type { RubricSummary } from "@/types/rubric";
import enMessages from "../../../../../../../../messages/en.json";

vi.mock("../../rubric-dialog", () => ({
  RubricDialog: () => <div data-testid="rubric-dialog" />,
}));
vi.mock("@/app/actions/rubrics", () => ({ deleteRubric: vi.fn() }));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));

const ONE_RUBRIC: RubricSummary[] = [
  {
    id: "1",
    name: "Support reply quality",
    evaluation_mode: "conversational",
    created_at: "2026-01-03T00:00:00Z",
  },
];

function renderRubrics({
  rubrics,
  canWrite,
  runCount = 0,
}: {
  rubrics: RubricSummary[];
  canWrite: boolean;
  runCount?: number;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OnboardingProvider
        data={{ rubricCount: rubrics.length, runCount }}
        canWrite={canWrite}
      >
        <GettingStartedCard />
        <RubricsPanel
          rubrics={rubrics}
          selectedId={null}
          onSelect={vi.fn()}
          canWrite={canWrite}
        />
      </OnboardingProvider>
    </NextIntlClientProvider>,
  );
}

describe("Guided first-run onboarding on /rubrics", () => {
  it("shows the card + coach-mark for a writable Team with no rubrics (2 steps)", () => {
    renderRubrics({ rubrics: [], canWrite: true });

    // "Getting started" card with the derived 0/2 count (paid Team: 2 steps).
    const card = screen.getByTestId("onboarding-card");
    expect(
      within(card).getByRole("heading", { name: "Getting started" }),
    ).toBeInTheDocument();
    expect(within(card).getByText("0/2")).toBeInTheDocument();
    expect(
      within(card).getByText("Create your first rubric"),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("Run your first evaluation"),
    ).toBeInTheDocument();

    // Coach-mark pinned to the create control, with verbose copy.
    expect(screen.getByTestId("coach-mark")).toBeInTheDocument();
    expect(
      screen.getByText(/This is where you create rubrics/i),
    ).toBeInTheDocument();
  });

  it("advances to the eval step once the Team has a rubric but no run (1/2)", () => {
    renderRubrics({ rubrics: ONE_RUBRIC, canWrite: true, runCount: 0 });

    // Card stays — the tutorial is not complete until the first eval runs.
    const card = screen.getByTestId("onboarding-card");
    expect(within(card).getByText("1/2")).toBeInTheDocument();
    // The create-rubric coach-mark is gone (that step is satisfied).
    expect(
      screen.queryByText(/This is where you create rubrics/i),
    ).not.toBeInTheDocument();
    // The create control still renders for writers.
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("hides the card + coach-marks once the Team has a rubric and a run (derived)", () => {
    renderRubrics({ rubrics: ONE_RUBRIC, canWrite: true, runCount: 1 });

    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/This is where you create rubrics/i),
    ).not.toBeInTheDocument();
    // The create control itself still renders for writers.
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("hides the card + coach-mark for Readonly Members even with no rubrics", () => {
    renderRubrics({ rubrics: [], canWrite: false });

    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    // Readonly Members don't get the create control at all.
    expect(
      screen.queryByRole("button", { name: "New" }),
    ).not.toBeInTheDocument();
  });

  it("does not vanish optimistically: lingers through the final flip, then drops", () => {
    function Card({ runCount }: { runCount: number }) {
      return (
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
          <OnboardingProvider data={{ rubricCount: 1, runCount }} canWrite>
            <GettingStartedCard />
          </OnboardingProvider>
        </NextIntlClientProvider>
      );
    }

    // A rubric exists but no run yet — the card shows the eval step pending.
    const { rerender } = render(<Card runCount={0} />);
    expect(screen.getByTestId("onboarding-card")).toBeInTheDocument();

    // Data revalidates to the satisfied final step. Re-rendering goes through the
    // lingering render (active is null, the completed checklist renders without
    // throwing) and settles to hidden — the card falls away on the next render.
    rerender(<Card runCount={1} />);
    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
  });
});
