import { cookies } from "next/headers";

/**
 * Name of the cookie that records a user's active organization (#52). It's a
 * *selection hint*, never a credential: `getAuthContext` only ever uses it to
 * pick among the memberships it independently reads, and derives role/orgId from
 * the membership row — so a forged value can't grant access to an org the user
 * isn't in. Shared here so the seam (reader) and `switchOrg` (writer) agree.
 */
export const ACTIVE_ORG_COOKIE = "active_org";

/**
 * Write the active-org selection hint (#52). The lone writer of
 * `ACTIVE_ORG_COOKIE`, shared so `switchOrg`, team creation, and invite
 * acceptance all land the cookie with identical attributes (httpOnly, lax,
 * site-wide, secure in prod). Callers still own their own membership check and
 * any post-write `revalidatePath`/`redirect`.
 */
export async function setActiveOrgCookie(orgId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
}
