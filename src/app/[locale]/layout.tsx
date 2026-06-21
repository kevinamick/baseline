import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { buildAlternates } from "@/i18n/metadata";
import { siteUrl } from "@/lib/site-url";
import {
  defaultOpenGraph,
  defaultTwitter,
  googleVerification,
} from "@/lib/seo";
import { PageView } from "@/app/_components/page-view";
import { WebVitals } from "@/app/_components/web-vitals";
import { UserIdentifier } from "@/app/_components/user-identifier";
import { ThemeScript } from "@/app/_components/theme-script";
import { OrgJsonLd } from "@/app/_components/org-json-ld";
import { CookieConsent } from "@/app/_components/cookie-consent";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Pre-render the root layout for every supported locale.
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });

  const title = t("siteTitle");
  const description = t("siteDescription");

  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    icons: { icon: "/favicon.svg" },
    // Home is the locale root; hreflang alternates + self-canonical keep the
    // auto-detect redirect (ADR-0011) SEO-safe.
    alternates: buildAlternates(locale, "/"),
    // Site-wide defaults; pages inherit and may override per page.
    openGraph: defaultOpenGraph(locale, "/", title, description),
    twitter: defaultTwitter(title, description),
    verification: googleVerification(),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  // The `[locale]` segment is effectively a catch-all, so reject unknown values.
  if (!hasLocale(routing.locales, locale)) notFound();
  // Opt this request's tree into the resolved locale (enables static rendering
  // and makes `getTranslations()` in nested pages resolve without a re-detect).
  setRequestLocale(locale);

  // Per-request CSP nonce (minted in proxy.ts) — required for the inline theme
  // script to run under script-src 'nonce-…' 'strict-dynamic'. Reading headers
  // opts the tree into dynamic rendering, which nonce-based CSP requires anyway.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Stamps [data-theme] before paint (no flash). Must precede styles. */}
        <ThemeScript nonce={nonce} />
        {/* Site-wide Organization graph for search engines. */}
        <OrgJsonLd nonce={nonce} />
      </head>
      <body className="min-h-full flex flex-col bg-paper font-sans text-ink">
        {/* Provides locale + messages to Client Components. Props are inherited
            from the request config (i18n/request.ts) when omitted. */}
        <NextIntlClientProvider>
          <PageView />
          <WebVitals />
          <UserIdentifier />
          {children}
          <CookieConsent />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
