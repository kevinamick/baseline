"use client";

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { NavAuth } from "@/lib/auth/nav";

/**
 * Client auth context for the app nav (#326 follow-up). Carries the per-request,
 * server-resolved identity the nav renders — active org, the switchable orgs, the
 * signed-in email, team-manage permission, and billing plan — seeded once by the
 * page (which already resolves it for its own gating) so the now-client `NavBar`
 * reads it via a hook instead of being an async Server Component that awaits
 * `getAuthContext()` on every navigation. Mirrors `billing-context.tsx`'s
 * seed-a-provider pattern.
 */
const AuthContext = createContext<NavAuth>({
  orgs: [],
  activeOrgId: null,
  email: null,
  canManageTeam: false,
  plan: null,
});

export function AuthProvider({
  orgs,
  activeOrgId,
  email,
  canManageTeam,
  plan,
  children,
}: NavAuth & { children: ReactNode }) {
  const value = useMemo(
    () => ({ orgs, activeOrgId, email, canManageTeam, plan }),
    [orgs, activeOrgId, email, canManageTeam, plan],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The nav identity (active org, switchable orgs, email, team-manage perm). */
export function useNavAuth(): NavAuth {
  return useContext(AuthContext);
}
