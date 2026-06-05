import { getAuthContext } from "@/lib/auth/context";
import { listUserOrgs } from "@/lib/auth/members";
import { NavBarClient } from "./nav-bar-client";

/**
 * Server wrapper for the app nav: resolves the signed-in identity, the active
 * org, and the full list of orgs the user can switch between (#52), then hands
 * them to the client nav for interactivity.
 */
export async function NavBar() {
  const { userId, email, orgId, canWrite } = await getAuthContext();

  const orgs = userId ? await listUserOrgs(userId) : [];

  return (
    <NavBarClient
      orgs={orgs}
      activeOrgId={orgId}
      email={email}
      canManageTeam={canWrite}
    />
  );
}
