"use server";

import { cookies } from "next/headers";
import { isValidLocale, LOCALE_COOKIE } from "@/lib/i18n/config";

export async function setLocale(locale: string): Promise<void> {
  if (!isValidLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}
