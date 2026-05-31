import { cookies, headers } from "next/headers";
import { defaultLocale, isValidLocale, LOCALE_COOKIE, type Locale } from "./config";
import { en, type Dictionary } from "./dictionaries/en";
import { es } from "./dictionaries/es";

const dictionaries: Record<Locale, Dictionary> = { en, es };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (cookie && isValidLocale(cookie)) return cookie;

  const headerStore = await headers();
  const acceptLanguage = headerStore.get("accept-language") ?? "";
  const preferred = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0].trim().slice(0, 2).toLowerCase())
    .find(isValidLocale);

  return preferred ?? defaultLocale;
}

export type { Locale, Dictionary };
