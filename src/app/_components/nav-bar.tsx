import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NavBarClient } from "./nav-bar-client";

/**
 * Server wrapper for the app nav: resolves the signed-in identity and the active
 * org's name (the seam returns `orgId`; the display name is fetched here, only
 * where it's shown), then hands them to the client nav for interactivity.
 */
export async function NavBar() {
  const { email, orgId } = await getAuthContext();

  const { data: org } = orgId
    ? await supabaseAdmin
        .from("organizations")
        .select("name")
        .eq("id", orgId)
        .maybeSingle()
    : { data: null };

  return <NavBarClient orgName={org?.name ?? null} email={email} />;
}
