// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  ComparisonContent,
  type ComparisonLabels,
} from "@/app/_components/comparison-content";
import type { Comparison } from "@/lib/marketing/comparisons";

const labels: ComparisonLabels = {
  whyHeading: "Why teams choose Baseline",
  sideBySide: "Baseline and Acme, side by side",
  colDimension: "How they compare",
  colBaseline: "Baseline",
  verifiedPrefix: "Comparison reflects publicly available information as of",
  verifiedOn: "June 21, 2026",
  correctionPrompt: "Spotted something out of date?",
  correctionCta: "Let us know",
  sourcesLabel: "Sources:",
};

const fixture: Comparison = {
  slug: "acme",
  competitor: "Acme",
  locales: ["en"],
  updatedAt: "2026-07-01",
  metaTitle: "Baseline vs Acme",
  metaDescription: "desc",
  heading: "Baseline vs Acme",
  intro: "Outcome-led intro about shipping with confidence.",
  asOf: "2026-06-21",
  whyBaseline: ["Score outputs against a Rubric", "Put quality on autopilot"],
  rows: [
    {
      dimension: "Scheduled evaluations",
      baseline: "A Schedule re-runs a Rubric on a cadence.",
      competitor: "Runs are wired up by the user.",
      sourceId: "acme-docs",
    },
  ],
  sources: [
    { id: "acme-docs", label: "Acme docs", url: "https://acme.example/docs" },
  ],
};

describe("ComparisonContent", () => {
  it("renders the data-driven heading, intro, and outcomes", () => {
    render(<ComparisonContent comparison={fixture} labels={labels} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Baseline vs Acme" })
    ).toBeInTheDocument();
    expect(screen.getByText(/shipping with confidence/i)).toBeInTheDocument();
    expect(screen.getByText("Put quality on autopilot")).toBeInTheDocument();
  });

  it("renders each row's dimension and both sides' claims in the table", () => {
    render(<ComparisonContent comparison={fixture} labels={labels} />);
    const table = screen.getByRole("table");
    expect(
      within(table).getByText("Scheduled evaluations")
    ).toBeInTheDocument();
    expect(
      within(table).getByText("A Schedule re-runs a Rubric on a cadence.")
    ).toBeInTheDocument();
    expect(
      within(table).getByText("Runs are wired up by the user.")
    ).toBeInTheDocument();
  });

  it("stamps the verification date as a machine-readable <time>", () => {
    render(<ComparisonContent comparison={fixture} labels={labels} />);
    const time = screen.getByText("June 21, 2026");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", "2026-06-21");
  });

  it("links every source, rel-tagged so we don't pass authority to competitors", () => {
    render(<ComparisonContent comparison={fixture} labels={labels} />);
    const link = screen.getByRole("link", { name: "Acme docs" });
    expect(link).toHaveAttribute("href", "https://acme.example/docs");
    expect(link).toHaveAttribute("rel", expect.stringContaining("nofollow"));
  });
});
