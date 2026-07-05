import type { Metadata } from "next";
import { getTranslations, getFormatter, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { BrandMark } from "@/app/_components/brand-mark";
import { SiteFooter } from "@/app/_components/site-footer";
import { CookiePreferencesButton } from "@/app/_components/cookie-preferences-button";
import { buildAlternates } from "@/i18n/metadata";
import { SUBPROCESSORS } from "@/lib/legal/subprocessors";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Privacy" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: buildAlternates(locale, "/privacy"),
  };
}

const LAST_UPDATED = new Date(Date.UTC(2026, 5, 18)); // 2026-06-18
const CONTACT_EMAIL = "support@baseline.ai";

// Cookies the app sets, split the same way the consent banner frames them.
// Cookie names are technical identifiers (not translated); the category and
// purpose are keyed into the Privacy catalog.
const COOKIES = [
  { name: "sb-*-auth-token", category: "strictlyNecessary", key: "authToken" },
  { name: "active_org", category: "strictlyNecessary", key: "activeOrg" },
  {
    name: "analytics_consent",
    category: "strictlyNecessary",
    key: "analyticsConsent",
  },
  { name: "ph_*", category: "analytics", key: "posthog" },
] as const;

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // This page reads no request-scoped data of its own, so opt it explicitly into
  // the segment's locale; otherwise getTranslations resolves the default locale.
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Privacy" });
  const f = await getFormatter();

  const mailLink = () => (
    <a
      href={`mailto:${CONTACT_EMAIL}`}
      className="font-medium text-accent hover:underline"
    >
      {CONTACT_EMAIL}
    </a>
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink transition-colors hover:bg-card-warm"
        >
          <BrandMark size={20} />
          Baseline
        </Link>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
          {t("heading")}
        </h1>
        <p className="mt-2 text-sm text-fg-3">
          {t("lastUpdated", {
            date: f.dateTime(LAST_UPDATED, { dateStyle: "long", timeZone: "UTC" }),
          })}
        </p>

        <div className="mt-8 flex flex-col gap-8 text-[15px] leading-relaxed text-fg-1">
          <Section title={t("whoTitle")}>
            <p>
              {t.rich("whoBody", {
                jur: (chunks) => chunks,
                mail: mailLink,
              })}
            </p>
          </Section>

          <Section title={t("collectTitle")}>
            <ul className="ml-5 list-disc space-y-1.5">
              {(
                ["collectAccount", "collectContent", "collectBilling", "collectAnalytics"] as const
              ).map((key) => (
                <li key={key}>
                  {t.rich(key, { b: (chunks) => <strong>{chunks}</strong> })}
                </li>
              ))}
            </ul>
          </Section>

          <Section title={t("retentionTitle")}>
            <p>{t("retentionBody")}</p>
          </Section>

          <Section title={t("rightsTitle")}>
            <p>
              {t.rich("rightsBody", {
                settings: (chunks) => (
                  <Link
                    href="/settings/account"
                    className="font-medium text-accent hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
                mail: mailLink,
              })}
            </p>
          </Section>

          <Section title={t("cookiesTitle")}>
            <p>{t("cookiesIntro")}</p>
            <Table
              columns={[
                t("cookiesHeader.cookie"),
                t("cookiesHeader.category"),
                t("cookiesHeader.purpose"),
              ]}
              rows={COOKIES.map((c) => [
                c.name,
                t(`cookieCategory.${c.category}`),
                t(`cookiePurpose.${c.key}`),
              ])}
              mono={[true, false, false]}
            />
            <p className="text-[13px] text-fg-2">
              {t.rich("cookiesManage", {
                prefs: (chunks) => (
                  <CookiePreferencesButton className="font-medium text-accent underline-offset-2 hover:underline">
                    {chunks}
                  </CookiePreferencesButton>
                ),
              })}
            </p>
          </Section>

          <Section title={t("subprocessorsTitle")}>
            <p>{t("subprocessorsIntro")}</p>
            {/* Vendor names and their per-vendor purpose/data/region come from the
                server-side subprocessor registry and stay in English for now — a
                data-layer i18n follow-up; the disclosure stays factually intact. */}
            <Table
              columns={[
                t("subprocessorsHeader.subprocessor"),
                t("subprocessorsHeader.purpose"),
                t("subprocessorsHeader.data"),
                t("subprocessorsHeader.region"),
              ]}
              rows={SUBPROCESSORS.map((s) => [s.name, s.purpose, s.data, s.region])}
              mono={[false, false, false, false]}
            />
          </Section>

          <Section title={t("transfersTitle")}>
            <p>{t("transfersBody")}</p>
          </Section>

          <Section title={t("changesTitle")}>
            <p>{t("changesBody")}</p>
          </Section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Table({
  columns,
  rows,
  mono,
}: {
  columns: string[];
  rows: string[][];
  mono: boolean[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline-cool">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-hairline-cool bg-card-warm">
            {columns.map((c) => (
              <th
                key={c}
                className="px-3 py-2 font-semibold text-fg-2"
                scope="col"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-hairline-cool last:border-0 align-top"
            >
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3 py-2 text-fg-1 ${mono[j] ? "font-mono text-[12px]" : ""}`}
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
}
