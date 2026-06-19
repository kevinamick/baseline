import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { AuthContext } from "@/lib/auth/context";

/**
 * org_id-enforcing query helper for tenant-scoped tables (#207).
 *
 * The app runs a service-role-everything model: all table I/O goes through
 * `supabaseAdmin`, which BYPASSES RLS by design (see
 * `supabase/migrations/20260614000000_service_role_table_grants.sql`). The 27
 * app tables enable RLS with NO policy, so there is no DB backstop — tenant
 * isolation lives entirely in app code. Every query on a tenant-scoped table
 * has to remember `.eq("org_id", ctx.orgId)`; one forgotten filter is a silent
 * cross-tenant leak.
 *
 * This wrapper makes the org filter structural rather than a thing you have to
 * remember at each call site:
 *   - `select()`  pre-applies `.eq("org_id", ctx.orgId)` before you chain.
 *   - `insert()`  stamps `org_id: ctx.orgId` and STRIPS any caller-supplied
 *     `org_id`, so a row can never land under another org's id.
 *   - `update()` / `delete()` pre-apply `.eq("org_id", ctx.orgId)`, so a write
 *     can only ever touch the caller's own rows.
 *
 * It returns the same Supabase query builder the raw client returns, so the
 * rest of a chain (`.eq("id", id)`, `.order(...)`, `.maybeSingle()`, awaiting
 * the result, `.select("id")` after an insert) is unchanged — only the org
 * filter is now guaranteed. Non-tenant tables (e.g. `memberships`, keyed by
 * `user_id`) are NOT part of this helper and stay on the raw admin client.
 *
 * The set of table names is a const tuple so it's the single source of truth for
 * "what is tenant-scoped" and call sites get autocomplete + a compile error on a
 * typo'd or non-tenant table name.
 *
 * CLASS-A ONLY. Every method here scopes by a literal `.eq("org_id", …)` column,
 * so this helper is for tables that carry their OWN `org_id` (rubrics, connections,
 * schedules, optimization_runs, provider_keys, …). The "class-B" tables that have no
 * `org_id` and are scoped through a parent join (`rubrics!inner(org_id)` / a run FK —
 * eval_runs, eval_run_rows/results, optimization_inputs/candidates/rollouts,
 * rollout_results, schedule_inputs) must NOT be added to this tuple: `.eq("org_id")`
 * would hit a non-existent column (Postgres 42703). They need a separate parent-scoped
 * path — see docs/tenant-db-migration.md.
 */
export const TENANT_SCOPED_TABLES = [
  "rubrics",
  // Migrate the rest of the class-A (own-`org_id`) tables through this helper
  // incrementally (see #207 follow-up / docs/tenant-db-migration.md):
  // "connections", "schedules", "optimization_runs", "provider_keys", ...
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/**
 * A `ctx` is usable for tenant I/O only once it has resolved an `orgId`. Call
 * sites already gate on `if (!userId || !orgId)`; this type lets the helper take
 * the narrowed context so `orgId` is non-null inside.
 */
type ScopedContext = AuthContext & { orgId: string };

function assertOrg(ctx: AuthContext): asserts ctx is ScopedContext {
  if (!ctx.orgId) {
    // A programming error: the helper must never be reached without an org. Call
    // sites resolve `getAuthContext()` and bail on a null org before any I/O.
    throw new Error("tenantDb requires an AuthContext with a resolved orgId");
  }
}

// `org_id` is never caller-controlled on a write — it comes from the AuthContext. Strip any
// `org_id` a payload carries so the helper alone decides it (insert stamps it; update must
// not move a row across orgs). Single-sourced so this security-critical line can't diverge
// between the insert and update paths.
function stripOrgId(values: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentionally drop a caller-supplied org_id
  const { org_id: _ignored, ...rest } = values;
  return rest;
}

/**
 * Scoped table operations for one `AuthContext`. Build it once per action with
 * `tenantDb(ctx)`, then call `.from(table)` for a thin org-enforcing facade over
 * the admin client.
 */
export function tenantDb(ctx: AuthContext) {
  assertOrg(ctx);
  const orgId = ctx.orgId;

  return {
    from(table: TenantScopedTable) {
      return {
        /**
         * Read all columns pre-scoped to this org. Chain the rest as usual
         * (`.eq("id", id)`, `.order(...)`, `.maybeSingle()`, await for rows).
         *
         * Intentionally `select("*")`-only for now: the admin client is untyped
         * (schema `any`), and threading a runtime column string through here
         * resolves a postgrest overload whose rows aren't readable by callers.
         * Column projection (`.select("id, name, ...")`) is a deliberate
         * follow-up once a typed `Database` schema lands — see the #207 PR
         * discussion. The migrated table (`rubrics`) only ever read `*`.
         */
        select() {
          return supabaseAdmin.from(table).select("*").eq("org_id", orgId);
        },

        /**
         * Insert with `org_id` stamped from the context. Any `org_id` on the
         * caller's payload is dropped first, so a forged/leaked org id can't
         * land the row under another tenant. Returns the builder so callers can
         * `.select("id").single()` exactly as before.
         */
        insert(values: Record<string, unknown>) {
          return supabaseAdmin.from(table).insert({ ...stripOrgId(values), org_id: orgId });
        },

        /**
         * Update pre-constrained to this org. Chain `.eq("id", id)` for the row;
         * the org filter is already applied so it can only touch own rows.
         */
        update(values: Record<string, unknown>) {
          return supabaseAdmin.from(table).update(stripOrgId(values)).eq("org_id", orgId);
        },

        /**
         * Delete pre-constrained to this org. Chain `.eq("id", id)` for the row.
         */
        delete() {
          return supabaseAdmin.from(table).delete().eq("org_id", orgId);
        },
      };
    },
  };
}
