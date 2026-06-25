"use client";

import { NavBarClient } from "./nav-bar-client";
import { useNavAuth } from "./auth-context";

/**
 * App nav. A Client Component (#326 follow-up): it reads the signed-in identity,
 * active org, and switchable orgs (#52) from the client `AuthProvider` — seeded
 * once per request by the page — and hands them to the presentational
 * `NavBarClient`. It no longer awaits `getAuthContext()`, so it no longer blocks
 * page transitions on a server-side auth round-trip each navigation.
 */
export function NavBar() {
  const { orgs, activeOrgId, email, canManageTeam } = useNavAuth();

  return (
    <NavBarClient
      orgs={orgs}
      activeOrgId={activeOrgId}
      email={email}
      canManageTeam={canManageTeam}
    />
  );
}
