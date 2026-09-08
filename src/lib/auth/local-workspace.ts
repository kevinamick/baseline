/**
 * The Local Workspace (ADR-0020): the one implicit owner of every Rubric,
 * Connection, Schedule, and run. There is no sign-in and no membership — whoever
 * reaches the running app is its sole Contributor.
 *
 * These ids are fixed so the migration that seeds the rows
 * (`supabase/migrations/20260907000000_local_workspace.sql`), the e2e seed, and
 * the app all agree without a lookup. The `organizations` table keeps this single
 * row and every tenant table's `org_id` points at it; `public.users` keeps the
 * matching row so the `created_by` columns stay valid.
 *
 * No `server-only` guard: the ids are not secrets, and client components (the
 * nav) may render the workspace name.
 */
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000002";
export const LOCAL_WORKSPACE_NAME = "Local Workspace";
