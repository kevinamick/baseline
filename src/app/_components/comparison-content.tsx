import type { Comparison } from "@/lib/marketing/comparisons";
import { CheckIcon } from "@/app/_components/icons";

/**
 * The data-driven body of a `/compare/{slug}` page (ADR-0013): intro, the
 * "why Baseline" outcomes, the side-by-side claims table, an `as of` verification
 * stamp, and linked sources. Pure and presentational — every word comes from the
 * passed `Comparison`, so adding a competitor is a data-only change. No i18n: the
 * marketing surface is English-only at launch and gets localized per page in #280.
 */
export function ComparisonContent({ comparison }: { comparison: Comparison }) {
  const { competitor, heading, intro, whyBaseline, rows, sources, asOf } =
    comparison;
  // Render the verification date in a stable, locale-independent long form so the
  // prerendered HTML is deterministic (no hydration drift, no per-locale parsing).
  const verifiedOn = formatVerifiedDate(asOf);

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
          Why teams choose Baseline
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
          {`Baseline and ${competitor}, side by side`}
        </h2>
        <div className="overflow-hidden rounded-2xl border border-hairline-cool bg-card">
          <table className="w-full border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-hairline-cool text-[13px] text-fg-3">
                <th scope="col" className="px-4 py-3 font-medium">
                  How they compare
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-ink">
                  Baseline
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
          Comparison reflects publicly available information as of{" "}
          <time dateTime={asOf}>{verifiedOn}</time>. Spotted something out of
          date?{" "}
          <a
            href="mailto:hello@baseline.dev?subject=Comparison%20correction"
            className="underline transition-colors hover:text-ink"
          >
            Let us know
          </a>
          .
        </p>
        {sources.length > 0 && (
          <p className="mt-2">
            <span className="font-medium text-fg-2">Sources:</span>{" "}
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

// "2026-06-21" → "June 21, 2026". Hand-rolled (not toLocaleDateString) so the
// output is identical on server and client regardless of the runtime's ICU data.
function formatVerifiedDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const month = months[(m ?? 1) - 1] ?? "";
  return `${month} ${d}, ${y}`;
}
