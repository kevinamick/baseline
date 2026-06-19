import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/app/_components/brand-mark";
import { SiteFooter } from "@/app/_components/site-footer";
import { SUBPROCESSORS } from "@/lib/legal/subprocessors";

export const metadata: Metadata = {
  title: "Privacy & Cookie Notice — Baseline",
  description:
    "How Baseline collects, uses, and protects personal data, the cookies we set, and the subprocessors we rely on.",
};

const LAST_UPDATED = "June 18, 2026";
const CONTACT_EMAIL = "support@baseline.ai";

// Cookies the app sets, split the same way the consent banner frames them.
// "Strictly necessary" cookies are exempt from consent; "Analytics" cookies are
// set by default (opt-out) and removed once the visitor opts out in the banner.
const COOKIES: ReadonlyArray<{
  name: string;
  category: "Strictly necessary" | "Analytics";
  purpose: string;
}> = [
  {
    name: "sb-*-auth-token",
    category: "Strictly necessary",
    purpose: "Keeps you signed in (Supabase authentication session).",
  },
  {
    name: "active_org",
    category: "Strictly necessary",
    purpose: "Remembers which organization you're currently working in.",
  },
  {
    name: "analytics_consent",
    category: "Strictly necessary",
    purpose: "Remembers your cookie choice so we don't ask again.",
  },
  {
    name: "ph_*",
    category: "Analytics",
    purpose: "PostHog product-analytics cookies — set unless you opt out.",
  },
];

export default function PrivacyPage() {
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
          Privacy &amp; Cookie Notice
        </h1>
        <p className="mt-2 text-sm text-fg-3">Last updated: {LAST_UPDATED}</p>

        <div className="mt-8 flex flex-col gap-8 text-[15px] leading-relaxed text-fg-1">
          <Section title="Who we are">
            <p>
              Baseline provides a platform for authoring rubrics and evaluating
              AI outputs. Baseline is the data
              controller for the personal data described here. Our governing law
              and place of establishment is{" "}
              {/* Placeholder pending legal sign-off — tracked in #234. */}
              <Placeholder>[JURISDICTION]</Placeholder>. If you have any
              questions or want to exercise your rights, contact us at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-accent hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </Section>

          <Section title="What we collect and why">
            <ul className="ml-5 list-disc space-y-1.5">
              <li>
                <strong>Account data</strong> — your email, name, and
                organization memberships, so we can authenticate you and provide
                the service. Legal basis: performance of our contract with you.
              </li>
              <li>
                <strong>Content you create</strong> — rubrics, datasets,
                evaluation runs, and related data you enter. Legal basis:
                performance of our contract with you.
              </li>
              <li>
                <strong>Billing data</strong> — subscription and payment
                identifiers, processed through Stripe. Legal basis: performance
                of our contract and compliance with legal obligations.
              </li>
              <li>
                <strong>Product analytics &amp; error monitoring</strong> —
                usage events, device/browser information, and error reports.
                Legal basis: our legitimate interest in maintaining and improving
                the service. You can opt out at any time via the cookie banner.
              </li>
            </ul>
          </Section>

          <Section title="How long we keep it">
            <p>
              We retain account and content data for as long as your account is
              active, and delete or anonymize it after you close your account,
              subject to any retention we must keep for legal, tax, or
              fraud-prevention reasons. Analytics data is retained according to
              each analytics provider&apos;s standard retention windows.
            </p>
          </Section>

          <Section title="Your rights">
            <p>
              You can access, correct, export, or erase your personal data. You
              can export your data or permanently delete your account at any time
              from{" "}
              <Link
                href="/settings/account"
                className="font-medium text-accent hover:underline"
              >
                Settings → Account
              </Link>
              . Depending on where you live, you may also have the right to
              restrict or object to processing, or to lodge a complaint with your
              local data-protection authority. To make any other request, email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-accent hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </Section>

          <Section title="Cookies">
            <p>
              We use a small number of cookies. Strictly-necessary cookies are
              required to run the service and are always active. Analytics
              cookies are on by default — you can turn them off at any time via
              the cookie banner without losing any functionality.
            </p>
            <Table
              columns={["Cookie", "Category", "Purpose"]}
              rows={COOKIES.map((c) => [c.name, c.category, c.purpose])}
              mono={[true, false, false]}
            />
          </Section>

          <Section title="Subprocessors">
            <p>
              We rely on the third-party services below to operate Baseline. Each
              processes personal data on our behalf under a data-processing
              agreement. You can opt out of the analytics subprocessors at any
              time via the cookie banner.
            </p>
            <Table
              columns={["Subprocessor", "Purpose", "Data", "Region"]}
              rows={SUBPROCESSORS.map((s) => [
                s.name,
                s.purpose,
                s.data,
                s.region,
              ])}
              mono={[false, false, false, false]}
            />
          </Section>

          <Section title="International transfers">
            <p>
              Some of our subprocessors are located in the United States. Where
              personal data is transferred outside your region, we rely on
              appropriate safeguards such as the European Commission&apos;s
              Standard Contractual Clauses.
            </p>
          </Section>

          <Section title="Changes to this notice">
            <p>
              We may update this notice from time to time. When we make material
              changes, we&apos;ll update the &quot;last updated&quot; date above
              and, where appropriate, notify you in the app.
            </p>
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

/** Visually flags a value the legal review still needs to fill in. */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-warning-bg px-1.5 py-0.5 font-mono text-[13px] text-warning-fg">
      {children}
    </span>
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
