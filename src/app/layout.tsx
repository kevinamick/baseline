import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { PageView } from "./_components/page-view";
import { WebVitals } from "./_components/web-vitals";
import { UserIdentifier } from "./_components/user-identifier";
import { LocaleProvider } from "@/lib/i18n/context";
import { getLocale, getDictionary } from "@/lib/i18n";
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
  const locale = await getLocale();
  const dictionary = getDictionary(locale);

  return (
    <ClerkProvider>
      <html
        lang={locale}
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-paper font-sans text-ink">
          <PageView />
          <WebVitals />
          <UserIdentifier />
          <LocaleProvider locale={locale} dictionary={dictionary}>
            {children}
          </LocaleProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
