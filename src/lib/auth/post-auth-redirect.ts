import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";

/**
 * Resolves where a freshly-authenticated user should land. If the user has no
 * org membership, returns `/onboarding` so the onboarding wizard shows
 * immediately (#355). Otherwise returns the original `next` destination.
 *
 * Shared by the password sign-in action and the OAuth/email-confirmation route
 * handlers so the post-auth onboarding redirect is consistent across all auth
 * entry points.
 */
export async function resolveOnboardingRedirect(
  user: User | null,
  next: string
): Promise<string> {
  if (!user) return next;

  const { data: memberships, error } = await supabaseAdmin
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1);

  if (error) return next;

  if (!memberships || memberships.length === 0) {
    return "/onboarding";
  }

  return next;
}
