"use client";

import { NavBarClient } from "./nav-bar-client";
import { useNavAuth } from "./auth-context";

/**
 * App nav. A Client Component (#326 follow-up): it reads the Workspace name and
 * plan from the client `AuthProvider` — seeded by the persistent
 * `(app)/layout.tsx` — and hands them to the presentational `NavBarClient`.
 * Hosting it in that shared layout (not the pages) keeps it mounted across
 * navigation, so it neither re-mounts nor blocks page transitions on a
 * server-side round-trip each navigation.
 */
export function NavBar() {
  const { workspaceName, plan } = useNavAuth();

  return <NavBarClient workspaceName={workspaceName} plan={plan} />;
}
