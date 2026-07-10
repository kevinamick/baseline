import { CATEGORIES } from "@/lib/marketing/categories";
import { COMPARISONS } from "@/lib/marketing/comparisons";
import { POSTS } from "@/lib/marketing/posts";
import { absoluteUrl } from "@/lib/site-url";
import enMessages from "../../../messages/en.json";

// `/llms.txt` (llmstxt.org): a markdown map of the public surface for AI
// agents and agent tooling (Claude Code, Cursor, etc. fetch it when pointed at
// a site; the big search crawlers mostly read the HTML directly). Generated
// from the same single-source marketing data that drives routing and the
// sitemap, so it can never drift from the real pages. English canonical URLs
// only — the file is one document, and en is the canonical locale (ADR-0013).
// The proxy matcher excludes `.txt`, so this bypasses locale routing and the
// auth gate exactly like `/robots.txt`.

/** `- [Title](url): description` — the llms.txt link-line convention. */
function line(title: string, path: string, description: string): string {
  // Strip the `<title>` branding suffix; the doc is already Baseline-scoped.
  const name = title.replace(/\s*[|—–-]\s*Baseline$/u, "").trim();
  return `- [${name}](${absoluteUrl(path)}): ${description}`;
}

export function GET(): Response {
  const meta = enMessages.Metadata;

  const body = [
    "# Baseline",
    "",
    `> ${meta.siteDescription}`,
    "",
    "## Guides",
    "",
    ...CATEGORIES.map((c) => line(c.metaTitle, `/${c.slug}`, c.metaDescription)),
    "",
    "## Comparisons",
    "",
    ...COMPARISONS.map((c) =>
      line(c.metaTitle, `/compare/${c.slug}`, c.metaDescription)
    ),
    "",
    "## Blog",
    "",
    ...POSTS.map((p) => line(p.heading, `/blog/${p.slug}`, p.description)),
    "",
    "## Company",
    "",
    line("Home", "/", meta.siteDescription),
    line("Pricing", "/pricing", meta.pricingDescription),
    line(
      "Docs",
      "/docs",
      "Product documentation and resources for running evaluations with Baseline."
    ),
    line(
      "Privacy",
      "/privacy",
      "Privacy and cookie notice covering the Baseline app and site."
    ),
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
