// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PostContent, type PostLabels } from "@/app/_components/post-content";
import type { Post } from "@/lib/marketing/posts";

const labels: PostLabels = { publishedLabel: "Published" };

const post: Post = {
  slug: "test-post",
  locales: ["en"],
  publishedAt: "2026-07-06",
  metaTitle: "Meta title",
  metaDescription: "Meta description",
  heading: "Post heading",
  ogSubtitle: "og subtitle",
  description: "Card description",
  dek: [
    [
      "Opening paragraph with a ",
      { text: "dek link", href: "/prompt-optimization" },
      " inline.",
    ],
    ["Opening paragraph two."],
  ],
  sections: [
    {
      heading: "First section",
      blocks: [
        { kind: "paragraph", segments: ["Plain prose."] },
        {
          kind: "paragraph",
          segments: [
            "Read the ",
            { text: "manual guide", href: "/manual-prompt-optimization" },
            " for more.",
          ],
        },
        {
          kind: "list",
          ordered: true,
          items: [
            [{ text: "First item", strong: true }, " detail."],
            [{ text: "Second item", strong: true }, " detail."],
          ],
        },
        {
          kind: "table",
          headers: ["Criterion", "Before", "After"],
          rows: [["Accuracy", "0.5", "0.9"]],
        },
        { kind: "pre", label: "Before", text: "the prompt text" },
        {
          kind: "image",
          src: "/docs/blog-test.png",
          alt: "A descriptive alt text over twenty characters",
          width: 1280,
          height: 577,
        },
      ],
    },
  ],
};

describe("PostContent", () => {
  it("renders the heading as the page h1 and the byline", () => {
    render(<PostContent post={post} labels={labels} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Post heading" })
    ).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
  });

  it("renders the dek and section prose", () => {
    render(<PostContent post={post} labels={labels} />);
    expect(screen.getByText("Opening paragraph two.")).toBeInTheDocument();
    expect(screen.getByText("Plain prose.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "First section" })
    ).toBeInTheDocument();
  });

  it("renders an inline link inside a dek paragraph", () => {
    render(<PostContent post={post} labels={labels} />);
    const link = screen.getByRole("link", { name: "dek link" });
    expect(link).toHaveAttribute("href", "/prompt-optimization");
  });

  it("renders an internal link with the localized href (default locale unprefixed)", () => {
    render(<PostContent post={post} labels={labels} />);
    const link = screen.getByRole("link", { name: "manual guide" });
    expect(link).toHaveAttribute("href", "/manual-prompt-optimization");
  });

  it("prefixes an internal link for a non-default locale", () => {
    render(<PostContent post={post} labels={labels} locale="es" />);
    const link = screen.getByRole("link", { name: "manual guide" });
    expect(link).toHaveAttribute("href", "/es/manual-prompt-optimization");
  });

  it("renders the ordered list with bold lead-ins", () => {
    render(<PostContent post={post} labels={labels} />);
    expect(screen.getByText("First item")).toBeInTheDocument();
    expect(screen.getByText("Second item")).toBeInTheDocument();
  });

  it("renders the table headers and rows", () => {
    render(<PostContent post={post} labels={labels} />);
    expect(screen.getByText("Criterion")).toBeInTheDocument();
    expect(screen.getByText("Accuracy")).toBeInTheDocument();
    expect(screen.getByText("0.9")).toBeInTheDocument();
  });

  it("renders the pre block with its label", () => {
    render(<PostContent post={post} labels={labels} />);
    const pre = screen.getByText("the prompt text");
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveAttribute("aria-label", "Before");
  });

  it("renders the image with its alt text", () => {
    render(<PostContent post={post} labels={labels} />);
    expect(
      screen.getByAltText("A descriptive alt text over twenty characters")
    ).toBeInTheDocument();
  });
});
