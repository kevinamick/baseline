/**
 * Name of the cookie that records a user's active organization (#52). It's a
 * *selection hint*, never a credential: `getAuthContext` only ever uses it to
 * pick among the memberships it independently reads, and derives role/orgId from
 * the membership row — so a forged value can't grant access to an org the user
 * isn't in. Shared here so the seam (reader) and `switchOrg` (writer) agree.
 */
export const ACTIVE_ORG_COOKIE = "active_org";
