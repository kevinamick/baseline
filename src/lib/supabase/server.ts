import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createRetryingFetch } from "@/lib/supabase/retrying-fetch";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // ADR-0018: GET/HEAD reads get one transparent retry on a transient
      // gateway blip; GoTrue/write traffic passes through untouched.
      global: { fetch: createRetryingFetch() },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // `setAll` is called from a Server Component render, where the
            // cookie store is read-only. Safe to ignore: the proxy refreshes
            // the session on every request, so the rotated cookies still land.
          }
        },
      },
    }
  );
}
