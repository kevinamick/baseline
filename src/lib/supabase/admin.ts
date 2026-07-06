import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createRetryingFetch } from "@/lib/supabase/retrying-fetch";

// Every table read this service-role client makes (including everything
// `tenantDb` wraps) goes through the ADR-0018 retrying fetch: GET/HEAD reads
// get one transparent retry on a transient gateway blip.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false },
    global: { fetch: createRetryingFetch() },
  }
);
