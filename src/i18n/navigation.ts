import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-aware navigation primitives. Use these (not `next/link` / `next/navigation`)
// on localized surfaces so the active locale prefix is preserved across clicks —
// e.g. an `es` visitor on `/es/pricing` follows a `Link href="/"` to `/es`, not `/`.
// With `localePrefix: 'as-needed'` these are a safe drop-in even where a target
// page isn't translated yet (the default locale stays unprefixed).
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
