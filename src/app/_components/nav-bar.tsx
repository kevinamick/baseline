"use client";

import { NavBarClient } from "./nav-bar-client";
import { useNavAuth } from "./auth-context";

/**
 * App nav. A Client Component (#326 follow-up): it reads the signed-in identity,
 * active org, and switchable orgs (#52) from the client `AuthProvider` — seeded
 * by the persistent `(app)/layout.tsx` — and hands them to the presentational
 * `NavBarClient`. Hosting it in that shared layout (not the pages) keeps it
 * mounted across navigation, so it neither re-mounts nor blocks page transitions
 * on a server-side auth round-trip each navigation.
 */
export function NavBar() {
  const { orgs, activeOrgId, email, canManageTeam, plan } = useNavAuth();

  return (
    <NavBarClient
      orgs={orgs}
      activeOrgId={activeOrgId}
      email={email}
      canManageTeam={canManageTeam}
      plan={plan}
    />
  );
}
