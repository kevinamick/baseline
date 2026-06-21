import { defaultLocale, type AppLocale } from "@/i18n/routing";

// Month names per locale, lowercased where the language wants it (es/fr write
// months in lower case mid-sentence). Hand-rolled rather than
// `toLocaleDateString` so the rendered string is byte-for-byte identical on
// server and client regardless of the runtime's ICU data — the comparison
// "as of" stamp is prerendered, so any drift would be a hydration mismatch.
const MONTHS: Record<AppLocale, readonly string[]> = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  es: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
  fr: [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
  ],
};

/**
 * Render an ISO date (`YYYY-MM-DD`) as a human "verified on" stamp in `locale`'s
 * conventional long form:
 *   en → "June 21, 2026"
 *   es → "21 de junio de 2026"
 *   fr → "21 juin 2026"
 * Used for the comparison-page verification date, which is shown next to a
 * machine-readable `<time dateTime={iso}>`.
 */
export function formatVerifiedDate(iso: string, locale: AppLocale): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = MONTHS[locale] ?? MONTHS[defaultLocale];
  const month = months[(m ?? 1) - 1] ?? "";
  switch (locale) {
    case "es":
      return `${d} de ${month} de ${y}`;
    case "fr":
      return `${d} ${month} ${y}`;
    default:
      return `${month} ${d}, ${y}`;
  }
}
