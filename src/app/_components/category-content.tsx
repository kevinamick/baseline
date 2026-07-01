import Image from "next/image";
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
  walkthroughHeading: string;
  howHeading: string;
  outcomesHeading: string;
  faqHeading: string;
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
}: {
  category: Category;
  labels: CategoryLabels;
}) {
  const { heading, intro, explainer, walkthrough, howBaseline, outcomes, faqs } =
    category;

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-ink">
          {heading}
        </h1>
        <p className="mt-5 text-[18px] leading-relaxed text-fg-2">{intro}</p>
      </header>

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

      {walkthrough.length > 0 && (
        <section aria-labelledby="walkthrough" className="mb-12">
          <h2
            id="walkthrough"
            className="mb-5 text-xl font-semibold tracking-[-0.015em] text-ink"
          >
            {labels.walkthroughHeading}
          </h2>
          <ol className="flex flex-col gap-8">
            {walkthrough.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[13px] font-semibold text-fg-on-ink"
                  >
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
                      {step.title}
                    </h3>
                    <p className="mt-1 text-[15px] leading-relaxed text-fg-2">
                      {step.body}
                    </p>
                  </div>
                </div>
                {step.image && (
                  <Image
                    src={step.image.src}
                    alt={step.image.alt}
                    width={1440}
                    height={900}
                    sizes="(max-width: 768px) 100vw, 720px"
                    className="w-full rounded-xl border border-hairline-cool shadow-card"
                  />
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

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
        <section aria-labelledby="faq">
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
    </article>
  );
}
