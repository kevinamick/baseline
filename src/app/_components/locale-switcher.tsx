"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { locales, type Locale } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/context";
import { setLocale } from "@/app/actions/locale";

const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  es: "ES",
};

export function LocaleSwitcher() {
  const { locale } = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleChange(next: Locale) {
    if (next === locale) return;
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <div className="inline-flex gap-0.5 rounded-full border border-hairline-cool bg-white p-1">
      {locales.map((l) => (
        <button
          key={l}
          type="button"
          disabled={isPending}
          onClick={() => handleChange(l)}
          aria-pressed={l === locale}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-50 ${
            l === locale
              ? "bg-ink text-white"
              : "text-zinc-600 hover:text-ink"
          }`}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
