import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { PageView } from "./_components/page-view";
import { WebVitals } from "./_components/web-vitals";
import { UserIdentifier } from "./_components/user-identifier";
import { ThemeScript } from "./_components/theme-script";
import { CookieConsent } from "./_components/cookie-consent";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Baseline",
  description:
    "Author rubrics, run them against your AI outputs, and ship with confidence.",
  icons: { icon: "/favicon.svg" },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonce (minted in proxy.ts) — required for the inline theme
  // script to run under script-src 'nonce-…' 'strict-dynamic'. Reading headers
  // opts the tree into dynamic rendering, which nonce-based CSP requires anyway.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Stamps [data-theme] before paint (no flash). Must precede styles. */}
        <ThemeScript nonce={nonce} />
      </head>
      <body className="min-h-full flex flex-col bg-paper font-sans text-ink">
        <PageView />
        <WebVitals />
        <UserIdentifier />
        {children}
        <CookieConsent />
      </body>
    </html>
  );
}
