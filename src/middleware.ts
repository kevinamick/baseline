import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { defaultLocale, isValidLocale, LOCALE_COOKIE } from "@/lib/i18n/config";

function detectLocale(request: NextRequest): string {
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  if (cookie && isValidLocale(cookie)) return cookie;

  const acceptLanguage = request.headers.get("accept-language") ?? "";
  const preferred = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0].trim().slice(0, 2).toLowerCase())
    .find(isValidLocale);

  return preferred ?? defaultLocale;
}

export default clerkMiddleware((_auth, request) => {
  const response = NextResponse.next();

  // Stamp the detected locale cookie so server components can read it
  // without touching headers (which aren't mutable in RSC).
  if (!request.cookies.get(LOCALE_COOKIE)) {
    const locale = detectLocale(request);
    response.cookies.set(LOCALE_COOKIE, locale, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return response;
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
