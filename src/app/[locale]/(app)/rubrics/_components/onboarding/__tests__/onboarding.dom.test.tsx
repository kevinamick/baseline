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
}: {
  rubrics: RubricSummary[];
  canWrite: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OnboardingProvider data={{ rubricCount: rubrics.length }} canWrite={canWrite}>
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
  it("shows the card + coach-mark for a writable Team with no rubrics", () => {
    renderRubrics({ rubrics: [], canWrite: true });

    // "Getting started" card with the derived 0/1 count.
    const card = screen.getByTestId("onboarding-card");
    expect(
      within(card).getByRole("heading", { name: "Getting started" }),
    ).toBeInTheDocument();
    expect(within(card).getByText("0/1")).toBeInTheDocument();
    expect(
      within(card).getByText("Create your first rubric"),
    ).toBeInTheDocument();

    // Coach-mark pinned to the create control, with verbose copy.
    expect(screen.getByTestId("coach-mark")).toBeInTheDocument();
    expect(
      screen.getByText(/This is where you create rubrics/i),
    ).toBeInTheDocument();
  });

  it("hides the card + coach-mark once the Team has a rubric (derived)", () => {
    renderRubrics({ rubrics: ONE_RUBRIC, canWrite: true });

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
});
