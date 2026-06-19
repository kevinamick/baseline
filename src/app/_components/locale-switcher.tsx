"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { locales } from "@/i18n/routing";

/**
 * Lets a visitor override the detected locale. next-intl's router persists the
 * choice to the NEXT_LOCALE cookie and re-renders the *same* path under the new
 * locale (`localePrefix: 'as-needed'` adds/removes the prefix). Driven from the
 * locale list so a new locale needs no change here (#242).
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("LocaleSwitcher");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <select
      aria-label={t("label")}
      value={locale}
      disabled={isPending}
      onChange={(event) => {
        const next = event.target.value;
        startTransition(() => {
          router.replace(pathname, { locale: next });
        });
      }}
      className={className}
    >
      {locales.map((l) => (
        <option key={l} value={l}>
          {t(l)}
        </option>
      ))}
    </select>
  );
}
