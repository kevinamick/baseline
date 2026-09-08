import "server-only";
import { cache } from "react";
import { setLogContext } from "@/lib/logging/request-context";
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/lib/auth/local-workspace";

/**
 * Coarse role. The Local Workspace has exactly one role — the Contributor
 * (`admin`) who may create, edit, delete, and run everything. The read-only
 * `member` role is kept in the type only so components that branch on
 * `canWrite` keep compiling; it is never produced at runtime (ADR-0020).
 */
export type Role = "admin" | "member";

export interface AuthContext {
  userId: string;
  /** Kept for callers that render an identity; the Local Workspace has none. */
  email: string | null;
  orgId: string;
  role: Role;
  /** Always true: whoever reaches the app is the Workspace's Contributor. */
  canWrite: boolean;
}

/**
 * The single server-side seam over identity. Every server read of "who is this
 * and which Workspace do they own" flows through here, so the shape stays one
 * definition even though the answer is now constant: the Local Workspace and
 * its Contributor (ADR-0020). No session, no cookie, no membership read.
 *
 * Still wrapped in React `cache()` so the log-context seeding happens once per
 * request, and so call sites keep their existing `await getAuthContext()` shape.
 */
export const getAuthContext = cache(async (): Promise<AuthContext> => {
  // Seed the per-request log context so every record emitted while handling this
  // request auto-correlates to the Workspace (./request-context.ts), the app-side
  // mirror of the worker logger's `org_id`.
  setLogContext({ user_id: LOCAL_USER_ID, org_id: LOCAL_WORKSPACE_ID });

  return {
    userId: LOCAL_USER_ID,
    email: null,
    orgId: LOCAL_WORKSPACE_ID,
    role: "admin",
    canWrite: true,
  };
});
