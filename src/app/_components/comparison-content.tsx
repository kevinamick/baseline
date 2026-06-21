import type { Comparison } from "@/lib/marketing/comparisons";
import { CheckIcon } from "@/app/_components/icons";

/**
 * The localized chrome around a comparison (headings, table column labels, the
 * "as of" sentence). The prose comes from the (already locale-resolved)
 * `Comparison`; these come from the next-intl `Marketing.comparison` catalog,
 * resolved by the route and passed in (#280). `sideBySide` is pre-interpolated with
 * the competitor name and `verifiedOn` is the date pre-formatted for the locale, so
 * this component stays pure and renders without an intl provider in tests.
 */
export interface ComparisonLabels {
  whyHeading: string;
  /** Pre-interpolated, e.g. "Baseline and Braintrust, side by side". */
  sideBySide: string;
  colDimension: string;
  colBaseline: string;
  verifiedPrefix: string;
  /** Date pre-formatted for the locale, e.g. "June 21, 2026". */
  verifiedOn: string;
  correctionPrompt: string;
  correctionCta: string;
  sourcesLabel: string;
}

/**
 * The data-driven body of a `/compare/{slug}` page (ADR-0013): intro, the
 * "why Baseline" outcomes, the side-by-side claims table, an `as of` verification
 * stamp, and linked sources. Pure and presentational — the prose comes from the
 * `Comparison` and the chrome from `labels` (#280), so adding a competitor is a
 * data-only change and translating one is a catalog change.
 */
export function ComparisonContent({
  comparison,
  labels,
}: {
  comparison: Comparison;
  labels: ComparisonLabels;
}) {
  const { competitor, heading, intro, whyBaseline, rows, sources, asOf } =
    comparison;

  return (
    <article className="mx-auto w-full max-w-4xl px-6 py-10">
      <header className="mb-8 text-center">
        <h1 className="text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-[-0.025em] text-ink">
          {heading}
        </h1>
        <p className="mx-auto mt-4 max-w-[640px] text-[16px] leading-relaxed text-fg-2">
          {intro}
        </p>
      </header>

      <section aria-labelledby="why-baseline" className="mb-10">
        <h2
          id="why-baseline"
          className="mb-4 text-lg font-semibold tracking-[-0.01em] text-ink"
        >
          {labels.whyHeading}
        </h2>
        <ul className="flex flex-col gap-2.5">
          {whyBaseline.map((point) => (
            <li
              key={point}
              className="flex items-start gap-2.5 text-[15px] text-fg-2"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <CheckIcon size={12} />
              </span>
              {point}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="comparison-table" className="mb-8">
        <h2
          id="comparison-table"
          className="mb-4 text-lg font-semibold tracking-[-0.01em] text-ink"
        >
          {labels.sideBySide}
        </h2>
        <div className="overflow-hidden rounded-2xl border border-hairline-cool bg-card">
          <table className="w-full border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-hairline-cool text-[13px] text-fg-3">
                <th scope="col" className="px-4 py-3 font-medium">
                  {labels.colDimension}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-ink">
                  {labels.colBaseline}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {competitor}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.dimension}
                  className="border-b border-hairline-cool last:border-b-0 align-top"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 font-medium text-ink"
                  >
                    {row.dimension}
                  </th>
                  <td className="px-4 py-3 text-fg-2">{row.baseline}</td>
                  <td className="px-4 py-3 text-fg-2">{row.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="text-[13px] text-fg-3">
        <p>
          {labels.verifiedPrefix}{" "}
          <time dateTime={asOf}>{labels.verifiedOn}</time>. {labels.correctionPrompt}{" "}
          <a
            href="mailto:hello@baseline.dev?subject=Comparison%20correction"
            className="underline transition-colors hover:text-ink"
          >
            {labels.correctionCta}
          </a>
          .
        </p>
        {sources.length > 0 && (
          <p className="mt-2">
            <span className="font-medium text-fg-2">{labels.sourcesLabel}</span>{" "}
            {sources.map((source, i) => (
              <span key={source.id}>
                {i > 0 && ", "}
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="underline transition-colors hover:text-ink"
                >
                  {source.label}
                </a>
              </span>
            ))}
          </p>
        )}
      </footer>
    </article>
  );
}
