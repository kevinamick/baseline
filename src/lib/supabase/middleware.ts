import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createRetryingFetch } from "@/lib/supabase/retrying-fetch";

/**
 * Refreshes the Supabase auth session — rotating the auth cookies onto the
 * response — and returns the validated user. Built for `proxy.ts`, which runs
 * outside the request-scoped `next/headers` store, so cookies are bridged
 * through the `NextRequest`/`NextResponse` pair here rather than via the server
 * client in `./server.ts`.
 *
 * `requestHeaders` are the (request-id-augmented) headers that should flow
 * downstream; they're attached to the response so Server Components and Route
 * Handlers observe them.
 *
 * IMPORTANT: nothing runs between `createServerClient` and `getUser()` — the
 * `@supabase/ssr` token refresh depends on it.
 */
export async function updateSession(
  request: NextRequest,
  requestHeaders: Headers
): Promise<{ user: User | null; response: NextResponse }> {
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // ADR-0018: GET/HEAD reads get one transparent retry on a transient
      // gateway blip; GoTrue/write traffic passes through untouched. Proxy
      // runs under the Node.js runtime by default (Next 16), so this is the
      // same server logger the rest of the app uses (see retrying-fetch.ts).
      global: { fetch: createRetryingFetch() },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { user, response };
}
