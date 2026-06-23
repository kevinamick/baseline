// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CategoryContent,
  type CategoryLabels,
} from "@/app/_components/category-content";
import type { Category } from "@/lib/marketing/categories";

const labels: CategoryLabels = {
  explainerHeading: "What it is, and why it matters",
  howHeading: "How Baseline does it",
  stepsHeading: "How to get started",
  prereqHeading: "You'll need",
  startCta: "Try Baseline free",
  troubleshootingHeading: "If something isn't working",
  outcomesHeading: "What you get",
  faqHeading: "Frequently asked questions",
  relatedHeading: "Related guides",
  backToGuides: "Guides",
  backgroundReadingHeading: "Background context",
};

const category: Category = {
  slug: "llm-evaluation",
  locales: ["en"],
  metaTitle: "Meta title",
  metaDescription: "Meta description",
  heading: "Category heading",
  angle: "the angle",
  ogSubtitle: "og subtitle",
  intro: "The intro paragraph.",
  explainer: ["First explainer paragraph.", "Second explainer paragraph."],
  howBaseline: [
    { feature: "Rubrics", body: "Author weighted criteria." },
    { feature: "Eval Runs", body: "Score outputs." },
  ],
  outcomes: ["First outcome.", "Second outcome."],
  faqs: [{ question: "Is it free?", answer: "Yes, there is a free tier." }],
};

describe("CategoryContent", () => {
  it("renders the heading as the page h1", () => {
    render(<CategoryContent category={category} labels={labels} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Category heading" })
    ).toBeInTheDocument();
  });

  it("renders the intro, explainer prose, product mapping, and outcomes", () => {
    render(<CategoryContent category={category} labels={labels} />);
    expect(screen.getByText("The intro paragraph.")).toBeInTheDocument();
    expect(screen.getByText("First explainer paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Rubrics")).toBeInTheDocument();
    expect(screen.getByText("Author weighted criteria.")).toBeInTheDocument();
    expect(screen.getByText("First outcome.")).toBeInTheDocument();
  });

  it("renders FAQ questions and answers", () => {
    render(<CategoryContent category={category} labels={labels} />);
    expect(screen.getByText("Is it free?")).toBeInTheDocument();
    expect(
      screen.getByText("Yes, there is a free tier.")
    ).toBeInTheDocument();
  });
});
