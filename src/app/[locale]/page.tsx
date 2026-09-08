import { redirect } from "next/navigation";
import { localizedPath } from "@/i18n/metadata";
import type { AppLocale } from "@/i18n/routing";

/**
 * The root URL opens the Local Workspace (ADR-0020): there is no sign-in and no
 * marketing landing to sell past, so `/` (and `/es`, `/fr`) go straight to the
 * dashboard in that locale.
 */
export default async function Home({
  params,
}: {
  params: Promise<{ locale: AppLocale }>;
}) {
  const { locale } = await params;
  redirect(localizedPath(locale, "/dashboard"));
}
