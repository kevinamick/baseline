import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

/**
 * Creates a Supabase SSR client for Route Handlers that bridges cookie writes
 * through a `NextResponse` — the response object the handler will return to
 * the browser.
 *
 * This is necessary because the `next/headers` `cookies()` API writes to an
 * internal response that is discarded when a Route Handler returns its own
 * `NextResponse` (e.g., a redirect). Without this bridge, session cookies set
 * by `verifyOtp` / `exchangeCodeForSession` never reach the browser, causing
 * a race where the first click of a magic link drops the user in a logged-out
 * state (#354).
 *
 * Mirrors the cookie-bridging pattern in `middleware.ts`'s `updateSession`,
 * adapted for Route Handler usage: `getAll` reads from the request, `setAll`
 * writes to both the request (so subsequent reads within the same call see
 * updated values) and the response (so the browser receives the cookies).
 */
export function createRouteClient(
  request: NextRequest,
  response: NextResponse
) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );
}
