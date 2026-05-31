"use client";

import { createContext, useContext } from "react";
import type { Dictionary } from "./dictionaries/en";
import type { Locale } from "./config";
import { en } from "./dictionaries/en";

interface LocaleContextValue {
  locale: Locale;
  t: Dictionary;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  t: en,
});

export function LocaleProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: React.ReactNode;
}) {
  return (
    <LocaleContext value={{ locale, t: dictionary }}>
      {children}
    </LocaleContext>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
