import type { Category } from "@/lib/marketing/categories";
import { CheckIcon } from "@/app/_components/icons";
import { InteractiveStepList } from "@/app/_components/interactive-step-list";

function difficultyBadgeClass(level: string): string {
  if (level === "Beginner") return "bg-success-bg text-success-fg";
  if (level === "Advanced") return "bg-accent/10 text-accent-ink";
  return "bg-fg-3/10 text-fg-3";
}

const ROUTE_LABELS: Record<string, string> = {
  "/rubrics": "Go to Rubrics",
  "/schedules": "Go to Schedules",
  "/optimizations": "Go to Optimizations",
  "/dashboard": "Go to Dashboard",
  "/settings/connections": "Go to Connections",
  "/settings/team": "Go to Team Settings",
};

function routeLabel(href: string): string {
  return ROUTE_LABELS[href] ?? "Open in Baseline";
}

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
  troubleshootingHeading: string;
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
  relatedCategories?: readonly { slug: string; heading: string; stepsGoal?: string; timeToComplete?: string; stepCount?: number; difficulty?: string }[];
}) {
  const { heading, intro, explainer, howBaseline, steps, stepsPrereq, stepsGoal, timeToComplete, difficulty, recommended, afterGuideNote, troubleshooting, outcomes, faqs, guideFaqs } = category;

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-ink">
          {heading}
        </h1>
        <p className="mt-5 text-[18px] leading-relaxed text-fg-2">{intro}</p>
      </header>

      {steps && steps.length > 0 && (
        <nav aria-label="Page sections" className="mb-10 flex flex-wrap gap-2">
          <a
            href="#steps"
            className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-[13px] font-medium text-fg-2 transition-colors hover:border-hairline-strong hover:text-ink"
          >
            {labels.stepsHeading}
          </a>
          {troubleshooting && troubleshooting.length > 0 && (
            <a
              href="#troubleshooting"
              className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-[13px] font-medium text-fg-2 transition-colors hover:border-hairline-strong hover:text-ink"
            >
              {labels.troubleshootingHeading}
            </a>
          )}
          <a
            href="#faq"
            className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-[13px] font-medium text-fg-2 transition-colors hover:border-hairline-strong hover:text-ink"
          >
            {labels.faqHeading}
          </a>
          {relatedCategories && relatedCategories.length > 0 && (
            <a
              href="#related"
              className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-[13px] font-medium text-fg-2 transition-colors hover:border-hairline-strong hover:text-ink"
            >
              {labels.relatedHeading}
            </a>
          )}
        </nav>
      )}

      {steps && steps.length > 0 && (
        <section aria-labelledby="steps" className="mb-12">
          <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2
              id="steps"
              className="text-xl font-semibold tracking-[-0.015em] text-ink"
            >
              {labels.stepsHeading}
            </h2>
            {recommended && (
              <span className="rounded-full bg-accent/12 px-2.5 py-0.5 text-[12px] font-semibold text-accent-ink">
                Start here
              </span>
            )}
            {difficulty && (
              <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${difficultyBadgeClass(difficulty)}`}>
                {difficulty}
              </span>
            )}
            {timeToComplete && (
              <span className="rounded-full bg-fg-3/10 px-2.5 py-0.5 text-[12px] font-medium text-fg-3">
                {timeToComplete}
              </span>
            )}
          </div>
          {stepsGoal && (
            <p className="mb-5 text-[15px] leading-relaxed text-fg-2">{stepsGoal}</p>
          )}
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
          <InteractiveStepList steps={steps} categorySlug={category.slug} relatedCategories={relatedCategories} afterGuideNote={afterGuideNote} />
          <a
            href="/sign-up"
            className="mt-7 inline-flex rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            {labels.startCta}
          </a>
        </section>
      )}

      {troubleshooting && troubleshooting.length > 0 && (
        <section aria-labelledby="troubleshooting" className="mb-12">
          <h2
            id="troubleshooting"
            className="mb-5 text-xl font-semibold tracking-[-0.015em] text-ink"
          >
            {labels.troubleshootingHeading}
          </h2>
          <ul className="flex flex-col gap-2">
            {troubleshooting.map((item) => (
              <li key={item.problem}>
                <details className="group rounded-xl border border-hairline-cool bg-card">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
                    <span className="text-[15px] font-semibold text-ink">
                      {item.problem}
                    </span>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-[13px] text-fg-3 transition-transform duration-200 group-open:rotate-180"
                    >
                      ↓
                    </span>
                  </summary>
                  <div className="border-t border-hairline-cool px-5 pb-4 pt-3">
                    <p className="text-[14px] leading-relaxed text-fg-2">
                      {item.solution}
                    </p>
                    {item.href && (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-[13px] font-medium text-accent-ink hover:underline"
                      >
                        {routeLabel(item.href)} →
                      </a>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(faqs.length > 0 || (guideFaqs && guideFaqs.length > 0)) && (
        <section aria-labelledby="faq" className="mb-12">
          <h2
            id="faq"
            className="mb-5 text-xl font-semibold tracking-[-0.015em] text-ink"
          >
            {labels.faqHeading}
          </h2>
          <ul className="flex flex-col gap-2">
            {[...(guideFaqs ?? []), ...faqs].map((faq) => (
              <li key={faq.question}>
                <details className="group rounded-xl border border-hairline-cool bg-card">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
                    <span className="text-[15px] font-semibold text-ink">
                      {faq.question}
                    </span>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-[13px] text-fg-3 transition-transform duration-200 group-open:rotate-180"
                    >
                      ↓
                    </span>
                  </summary>
                  <div className="border-t border-hairline-cool px-5 pb-4 pt-3">
                    <p className="text-[14px] leading-relaxed text-fg-2">
                      {faq.answer}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {relatedCategories && relatedCategories.length > 0 && (
        <section aria-labelledby="related" className="mb-12">
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
                  className="group flex flex-col gap-2 rounded-xl border border-hairline-cool bg-card px-5 py-4 transition-colors hover:border-accent/40 hover:bg-card-hover"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[15px] font-medium text-ink">
                      {rel.heading}
                    </span>
                    <span className="shrink-0 text-fg-3 transition-colors group-hover:text-ink">→</span>
                  </div>
                  {rel.stepsGoal && (
                    <p className="line-clamp-2 text-[13px] leading-relaxed text-fg-2">
                      {rel.stepsGoal}
                    </p>
                  )}
                  {(rel.stepCount != null || rel.timeToComplete != null || rel.difficulty != null) && (
                    <div className="flex flex-wrap gap-2">
                      {rel.difficulty != null && (
                        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${difficultyBadgeClass(rel.difficulty)}`}>
                          {rel.difficulty}
                        </span>
                      )}
                      {rel.stepCount != null && (
                        <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent-ink">
                          {rel.stepCount} steps
                        </span>
                      )}
                      {rel.timeToComplete != null && (
                        <span className="rounded-full bg-fg-3/10 px-2.5 py-0.5 text-[11px] font-medium text-fg-3">
                          {rel.timeToComplete}
                        </span>
                      )}
                    </div>
                  )}
                </a>
              </li>
            ))}
          </ul>
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

      <section aria-labelledby="outcomes">
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
    </article>
  );
}
