"use client";

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { NavAuth } from "@/lib/auth/nav";
import { LOCAL_WORKSPACE_NAME } from "@/lib/auth/local-workspace";

/**
 * Client context for the app nav (#326 follow-up). Carries the per-request,
 * server-resolved Workspace name — seeded once by the `(app)` layout
 * so the client `NavBar` reads it via a hook instead of being an async Server
 * Component that awaits a server read on every navigation. Mirrors
 * `billing-context.tsx`'s seed-a-provider pattern.
 */
const AuthContext = createContext<NavAuth>({
  workspaceName: LOCAL_WORKSPACE_NAME,
});

export function AuthProvider({
  workspaceName,
  children,
}: NavAuth & { children: ReactNode }) {
  const value = useMemo(() => ({ workspaceName }), [workspaceName]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The nav identity (Workspace name). */
export function useNavAuth(): NavAuth {
  return useContext(AuthContext);
}
