import Image from "next/image";
import type { Post, PostBlock, PostSegment } from "@/lib/marketing/posts";
import { formatVerifiedDate } from "@/lib/marketing/format-date";
import { defaultLocale, type AppLocale } from "@/i18n/routing";

/**
 * The localized section chrome around a post (currently just the byline
 * "Published" label). Kept as a prop, not a hook, for the same reason
 * `CategoryLabels`/`ComparisonLabels` are: this component stays pure and
 * renders without an intl provider in tests.
 */
export interface PostLabels {
  publishedLabel: string;
}

/** Prefix an internal path for the active locale, mirroring `localePrefix:
 * "as-needed"` (no prefix for the default locale) — same approach
 * `CategoryContent`'s `closingLink` uses, so this component stays free of
 * next-intl's client navigation wiring. */
function localizeHref(locale: AppLocale, href: string): string {
  return locale === defaultLocale ? href : `/${locale}${href}`;
}

/** A URL/DOM-safe id for a section heading, e.g. for `id`/`aria-labelledby`. */
function sectionId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function renderSegments(segments: readonly PostSegment[], locale: AppLocale) {
  return segments.map((segment, i) => {
    if (typeof segment === "string") return <span key={i}>{segment}</span>;
    if (segment.href) {
      // External links (the social callouts) pass through untouched; internal
      // paths get the locale prefix, as before.
      const external = /^https?:\/\//.test(segment.href);
      return (
        <a
          key={i}
          href={external ? segment.href : localizeHref(locale, segment.href)}
          {...(external ? { rel: "noopener noreferrer" } : {})}
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          {segment.text}
        </a>
      );
    }
    if (segment.strong) {
      return (
        <strong key={i} className="font-semibold text-ink">
          {segment.text}
        </strong>
      );
    }
    return <span key={i}>{segment.text}</span>;
  });
}

function Block({ block, locale }: { block: PostBlock; locale: AppLocale }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="text-[15.5px] leading-relaxed text-fg-2">
          {renderSegments(block.segments, locale)}
        </p>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag
          className={`flex flex-col gap-2 pl-5 text-[15.5px] leading-relaxed text-fg-2 marker:font-semibold marker:text-ink ${
            block.ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {block.items.map((item, i) => (
            <li key={i}>{renderSegments(item, locale)}</li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-2xl border border-hairline-cool bg-card">
          <table className="w-full min-w-[420px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-hairline-cool text-[13px] text-fg-3">
                {block.headers.map((header) => (
                  <th key={header} scope="col" className="px-4 py-3 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-hairline-cool text-fg-2 last:border-b-0"
                >
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={
                        j === 0
                          ? "px-4 py-3 font-medium text-ink"
                          : "px-4 py-3"
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "pre":
      return (
        <div className="flex flex-col gap-2">
          {block.label && (
            <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-3">
              {block.label}
            </p>
          )}
          <pre
            aria-label={block.label}
            className="w-full overflow-x-auto whitespace-pre-wrap rounded-xl border border-hairline-cool bg-card p-5 font-mono text-[13.5px] leading-relaxed text-fg-2 shadow-sm"
          >
            {block.text}
          </pre>
        </div>
      );
    case "video":
      // Privacy-enhanced YouTube embed: youtube-nocookie.com sets no cookies
      // until the visitor presses play, consistent with the opt-in consent
      // posture (#68). Host allow-listed in csp.ts frame-src.
      return (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${block.videoId}`}
          title={block.title}
          loading="lazy"
          allow="encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="aspect-video w-full rounded-xl border border-hairline-cool shadow-card"
        />
      );
    case "image":
      return (
        <Image
          src={block.src}
          alt={block.alt}
          width={block.width}
          height={block.height}
          sizes="(max-width: 768px) 100vw, 720px"
          className="w-full rounded-xl border border-hairline-cool shadow-card"
        />
      );
  }
}

/**
 * The prose-led body of a `/blog/{slug}` post (#435): heading, byline, opening
 * dek, then section by section. Pure and presentational, like
 * `CategoryContent`/`ComparisonContent` — the prose comes from the (already
 * locale-resolved) `Post`, the chrome from `labels`.
 */
export function PostContent({
  post,
  labels,
  locale = defaultLocale,
}: {
  post: Post;
  labels: PostLabels;
  locale?: AppLocale;
}) {
  const { heading, publishedAt, dek, sections } = post;

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-ink">
          {heading}
        </h1>
        <p className="mt-4 text-sm text-fg-3">
          {labels.publishedLabel}{" "}
          <time dateTime={publishedAt}>
            {formatVerifiedDate(publishedAt, locale)}
          </time>
        </p>
        <div className="mt-6 flex flex-col gap-4">
          {dek.map((para, i) => (
            <p key={i} className="text-[18px] leading-relaxed text-fg-2">
              {renderSegments(para, locale)}
            </p>
          ))}
        </div>
      </header>

      <div className="flex flex-col gap-12">
        {sections.map((section) => (
          <section
            key={section.heading}
            aria-labelledby={sectionId(section.heading)}
          >
            <h2
              id={sectionId(section.heading)}
              className="mb-4 text-xl font-semibold tracking-[-0.015em] text-ink"
            >
              {section.heading}
            </h2>
            <div className="flex flex-col gap-4">
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} locale={locale} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
