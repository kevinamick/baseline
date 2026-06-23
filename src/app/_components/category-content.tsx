import type { Category } from "@/lib/marketing/categories";
import { CheckIcon } from "@/app/_components/icons";

/**
 * The localized section headings (the page "chrome"), separate from the `Category`
 * prose. The data file carries the per-locale content; these come from the next-intl
 * `Marketing.category` catalog, resolved by the route and passed in. Kept as a prop
 * (not a hook) so this component stays pure and renders without an intl provider in
 * tests.
 */
export interface CategoryLabels {
  explainerHeading: string;
  howHeading: string;
  stepsHeading: string;
  prereqHeading: string;
  startCta: string;
  outcomesHeading: string;
  faqHeading: string;
  relatedHeading: string;
}

/**
 * The prose-led body of a category lander (#278): intro, a plain-language explainer,
 * the "how Baseline does it" mapping to product primitives, outcome bullets, and a
 * buyer FAQ. Pure and presentational — the prose comes from the (already
 * locale-resolved) `Category` and the section headings from `labels` (#280), so
 * adding a category is a data-only change and translating one is a catalog change.
 */
export function CategoryContent({
  category,
  labels,
  relatedCategories,
}: {
  category: Category;
  labels: CategoryLabels;
  relatedCategories?: readonly { slug: string; heading: string }[];
}) {
  const { heading, intro, explainer, howBaseline, steps, stepsPrereq, timeToComplete, outcomes, faqs } = category;

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-ink">
          {heading}
        </h1>
        <p className="mt-5 text-[18px] leading-relaxed text-fg-2">{intro}</p>
      </header>

      {steps && steps.length > 0 && (
        <section aria-labelledby="steps" className="mb-12">
          <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2
              id="steps"
              className="text-xl font-semibold tracking-[-0.015em] text-ink"
            >
              {labels.stepsHeading}
            </h2>
            {timeToComplete && (
              <span className="rounded-full bg-fg-3/10 px-2.5 py-0.5 text-[12px] font-medium text-fg-3">
                {timeToComplete}
              </span>
            )}
          </div>
          {stepsPrereq && stepsPrereq.length > 0 && (
            <div className="mb-6 rounded-xl border border-hairline-cool bg-card px-5 py-4">
              <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-3">
                {labels.prereqHeading}
              </p>
              <ul className="flex flex-col gap-1.5">
                {stepsPrereq.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-[14px] text-fg-2">
                    <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ol className="flex flex-col gap-4">
            {steps.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
                  {i + 1}
                </span>
                <div className="pt-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <p className="text-[15px] font-semibold text-ink">{step.title}</p>
                    {step.href && (
                      <a
                        href={step.href}
                        className="text-[13px] font-medium text-accent-ink hover:underline"
                      >
                        Open in Baseline →
                      </a>
                    )}
                  </div>
                  <p className="mt-1 text-[14px] leading-relaxed text-fg-2">
                    {step.description}
                  </p>
                  {step.tip && (
                    <p className="mt-2 rounded-lg bg-accent/8 px-3 py-2 text-[13px] leading-relaxed text-fg-2">
                      <span className="font-semibold text-accent">Tip: </span>
                      {step.tip}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <a
            href="/sign-up"
            className="mt-7 inline-flex rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            {labels.startCta}
          </a>
        </section>
      )}

      <section aria-labelledby="explainer" className="mb-12">
        <h2
          id="explainer"
          className="mb-4 text-xl font-semibold tracking-[-0.015em] text-ink"
        >
          {labels.explainerHeading}
        </h2>
        <div className="flex flex-col gap-4">
          {explainer.map((para) => (
            <p key={para} className="text-[15.5px] leading-relaxed text-fg-2">
              {para}
            </p>
          ))}
        </div>
      </section>

      <section aria-labelledby="how-baseline" className="mb-12">
        <h2
          id="how-baseline"
          className="mb-5 text-xl font-semibold tracking-[-0.015em] text-ink"
        >
          {labels.howHeading}
        </h2>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {howBaseline.map((item) => (
            <div
              key={item.feature}
              className="rounded-2xl border border-hairline-cool bg-card p-5 shadow-sm"
            >
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
                {item.feature}
              </h3>
              <p className="mt-1.5 text-sm leading-normal text-fg-2">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="outcomes" className="mb-12">
        <h2
          id="outcomes"
          className="mb-4 text-xl font-semibold tracking-[-0.015em] text-ink"
        >
          {labels.outcomesHeading}
        </h2>
        <ul className="flex flex-col gap-2.5">
          {outcomes.map((outcome) => (
            <li
              key={outcome}
              className="flex items-start gap-2.5 text-[15px] text-fg-2"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <CheckIcon size={12} />
              </span>
              {outcome}
            </li>
          ))}
        </ul>
      </section>

      {faqs.length > 0 && (
        <section aria-labelledby="faq" className="mb-12">
          <h2
            id="faq"
            className="mb-5 text-xl font-semibold tracking-[-0.015em] text-ink"
          >
            {labels.faqHeading}
          </h2>
          <dl className="flex flex-col gap-5">
            {faqs.map((faq) => (
              <div key={faq.question}>
                <dt className="text-[15px] font-semibold text-ink">
                  {faq.question}
                </dt>
                <dd className="mt-1.5 text-[15px] leading-relaxed text-fg-2">
                  {faq.answer}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {relatedCategories && relatedCategories.length > 0 && (
        <section aria-labelledby="related">
          <h2
            id="related"
            className="mb-4 text-xl font-semibold tracking-[-0.015em] text-ink"
          >
            {labels.relatedHeading}
          </h2>
          <ul className="flex flex-col gap-3">
            {relatedCategories.map((rel) => (
              <li key={rel.slug}>
                <a
                  href={`/${rel.slug}`}
                  className="flex items-center justify-between rounded-xl border border-hairline-cool bg-card px-5 py-4 transition-colors hover:border-accent/40 hover:bg-card-hover"
                >
                  <span className="text-[15px] font-medium text-ink">
                    {rel.heading}
                  </span>
                  <span className="text-fg-3">→</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
