import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Database } from "./database.types";
import type { AuthContext } from "@/lib/auth/context";

/**
 * Helper-scoped typing decision (#207).
 *
 * (a) of this PR LANDS the generated schema (`database.types.ts`, committed +
 * eslint-ignored) and exposes a `TableRow<T>` utility derived from it, so call
 * sites can annotate results against the real schema
 * (`TableRow<"rubrics">`). What it deliberately does NOT do is type the query
 * BUILDER: `supabaseAdmin` (`src/lib/supabase/admin.ts`) is UNTYPED
 * (`createClient(...)` with no `Database` generic), and threading the schema
 * through a `SupabaseClient<Database>` view + Supabase's `.select(<column-string>)`
 * generic parser exploded `tsc` memory — the typecheck OOMed at a 6 GB heap,
 * where the untyped baseline passes in ~46 s well under CI's default. A `.returns<…>()`
 * cast doesn't help: it yields a transform builder that drops `.eq(...)`, which
 * every call site still needs to chain. So the helper keeps building on the
 * untyped client (cheap, builder data is `any` exactly as before this PR) and the
 * org-scoping guarantees below are unchanged. Schema-typed builder results — and
 * globally typing `supabaseAdmin` (~70 call sites) — are a deliberate follow-up
 * (it needs the typed client, whose tsc cost has to be solved first).
 */
export type TableRow<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

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
  // optimization_runs carries its own org_id (class-A). It's read org-scoped in
  // deleteRubric's settle path (#207 tracer / #255); the rest of its call sites
  // migrate incrementally.
  "optimization_runs",
  // Migrate the rest of the class-A (own-`org_id`) tables through this helper
  // incrementally (see #207 follow-up / docs/tenant-db-migration.md):
  // "connections", "schedules", "provider_keys", ...
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
         * Read pre-scoped to this org. Chain the rest as usual (`.eq("id", id)`,
         * `.order(...)`, `.maybeSingle()`, await for rows). `columns` defaults to
         * `"*"` (existing `rubrics` call sites are behavior-preserving) and projects
         * at runtime when narrowed. Builder data is untyped (`any`) for now — see the
         * file header for why typed builder results are deferred; call sites that want
         * a static shape can annotate with the exported `TableRow<"…">`.
         */
        select(columns: string = "*") {
          // `columns` is a runtime string; cast it to the `"*"` literal so Supabase's
          // compile-time select-string parser takes its cheap, untyped `"*"` path
          // (the typed parser both OOMs tsc and rejects a non-literal string). The
          // real `columns` value still reaches PostgREST at runtime.
          return supabaseAdmin.from(table).select(columns as "*").eq("org_id", orgId);
        },

        /**
         * Insert with `org_id` stamped from the context. Any `org_id` on the
         * caller's payload is dropped first, so a forged/leaked org id can't
         * land the row under another tenant. Returns the builder so callers can
         * `.select("id").single()` exactly as before.
         */
        insert(values: Record<string, unknown>) {
          return supabaseAdmin
            .from(table)
            .insert({ ...stripOrgId(values), org_id: orgId });
        },

        /**
         * Update pre-constrained to this org. Chain `.eq("id", id)` for the row;
         * the org filter is already applied so it can only touch own rows.
         */
        update(values: Record<string, unknown>) {
          return supabaseAdmin
            .from(table)
            .update(stripOrgId(values))
            .eq("org_id", orgId);
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

/**
 * CLASS-B (parent-scoped) tables (#207).
 *
 * These tables carry NO `org_id` of their own; they belong to an org only
 * transitively, through a parent-FK chain that eventually reaches a row with an
 * `org_id` (a `rubrics` or an `optimization_runs`/`schedules`). A `.eq("org_id",
 * …)` on them would hit a non-existent column (Postgres 42703).
 *
 * To scope a READ, PostgREST embeds the parent(s) with `!inner` (an inner join,
 * so a child whose parent is in another org drops out) and filters on the
 * embedded `org_id` column via its dotted path. This map is the single source of
 * truth for that shape, one entry per class-B table:
 *
 *   - `embed`     the embed string appended to the projected columns, e.g.
 *                 `"optimization_runs!inner(org_id)"` (1 hop) or
 *                 `"eval_runs!inner(rubrics!inner(org_id))"` (2 hop).
 *   - `filterKey` the dotted column the org filter is applied to, e.g.
 *                 `"optimization_runs.org_id"` / `"eval_runs.rubrics.org_id"`.
 *
 * Chains verified against `database.types.ts` Relationships AND smoke-tested
 * against a live PostgREST (each embed+filter must parse, not just typecheck):
 *   eval_runs                → rubrics(rubric_id).org_id                       [1]
 *   eval_run_rows            → eval_runs(eval_run_id) → rubrics                [2]
 *   eval_run_results         → eval_runs(eval_run_id) → rubrics               [2]
 *   optimization_inputs      → optimization_runs(opt_run_id).org_id            [1]
 *   optimization_candidates  → optimization_runs(opt_run_id).org_id            [1]
 *   optimization_rollouts    → optimization_candidates(candidate_id) → runs    [2]
 *   rollout_results          → optimization_rollouts(rollout_id) → cand → runs [3]
 *   schedule_inputs          → schedules(schedule_id).org_id                   [1]
 *
 * DISAMBIGUATION: `optimization_runs` has a `best_candidate_id` FK back to
 * `optimization_candidates`, so candidate↔run has TWO relationships and a bare
 * `optimization_runs!inner(...)` embed is ambiguous (PostgREST PGRST201). Every
 * hop that crosses candidate→run therefore pins the FK explicitly with
 * `optimization_runs!opt_run_id!inner(...)`.
 */
export const CLASS_B_PARENT_SCOPE = {
  eval_runs: {
    embed: "rubrics!inner(org_id)",
    filterKey: "rubrics.org_id",
  },
  eval_run_rows: {
    embed: "eval_runs!inner(rubrics!inner(org_id))",
    filterKey: "eval_runs.rubrics.org_id",
  },
  eval_run_results: {
    embed: "eval_runs!inner(rubrics!inner(org_id))",
    filterKey: "eval_runs.rubrics.org_id",
  },
  optimization_inputs: {
    embed: "optimization_runs!inner(org_id)",
    filterKey: "optimization_runs.org_id",
  },
  optimization_candidates: {
    // candidate→run is ambiguous (optimization_runs.best_candidate_id points back);
    // pin the FK with !opt_run_id. (See DISAMBIGUATION note above.)
    embed: "optimization_runs!opt_run_id!inner(org_id)",
    filterKey: "optimization_runs.org_id",
  },
  optimization_rollouts: {
    embed: "optimization_candidates!inner(optimization_runs!opt_run_id!inner(org_id))",
    filterKey: "optimization_candidates.optimization_runs.org_id",
  },
  rollout_results: {
    embed:
      "optimization_rollouts!inner(optimization_candidates!inner(optimization_runs!opt_run_id!inner(org_id)))",
    filterKey:
      "optimization_rollouts.optimization_candidates.optimization_runs.org_id",
  },
  schedule_inputs: {
    embed: "schedules!inner(org_id)",
    filterKey: "schedules.org_id",
  },
} as const satisfies Record<string, { embed: string; filterKey: string }>;

export type ParentScopedTable = keyof typeof CLASS_B_PARENT_SCOPE;

/**
 * Org-scoping facade for CLASS-B tables (no own `org_id`), scoped through a
 * parent-FK chain — the read-side companion to `tenantDb`.
 *
 * `parentScoped(ctx).from(table).select(columns)` returns the same PostgREST
 * read builder a raw `.select()` would, so the rest of a chain (`.eq("id", …)`,
 * `.in(...)`, `.order(...)`, `.maybeSingle()`, awaiting rows) is unchanged — the
 * embedded `!inner` join + org filter are pre-applied so a child belonging to
 * another org's parent is structurally excluded. The projected columns are
 * augmented with the embed string and the org filter applied to the embedded
 * `org_id`, both sourced from `CLASS_B_PARENT_SCOPE`.
 *
 * WRITES are deliberately NOT exposed here. PostgREST cannot filter an UPDATE or
 * DELETE by an embedded/joined column — `.update(...).eq("rubrics.org_id", …)`
 * is not expressible — so any "scoped" class-B write would have to fake the
 * guard, which is exactly the cross-tenant footgun this helper exists to remove.
 * In practice class-B rows are written in two trusted ways that don't need an
 * org filter on the write itself:
 *   1. They are cascade-deleted with their parent (delete the `rubrics` row and
 *      its `eval_runs`/rows/results go with it), and
 *   2. They are inserted/updated by the Temporal worker inside an
 *      already-org-validated workflow (the worker resolved the parent's org
 *      before touching the child).
 * If an app-side scoped class-B write is ever genuinely needed, do it as an
 * explicit two-step: resolve the org-owned ids via `parentScoped(...).select("id")`
 * first, then `tenantDb`/raw `.in("id", ids)` against those resolved ids — never
 * a single statement pretending to filter by a joined column. See
 * docs/tenant-db-migration.md.
 */
export function parentScoped(ctx: AuthContext) {
  assertOrg(ctx);
  const orgId = ctx.orgId;

  return {
    from(table: ParentScopedTable) {
      const { embed, filterKey } = CLASS_B_PARENT_SCOPE[table];
      return {
        /**
         * Read pre-scoped to this org through the parent chain. `columns`
         * defaults to `"*"`; the parent embed is appended automatically so the
         * inner join + org filter are always present. Chain the rest as usual
         * (`.eq("id", …)`, `.in(...)`, `.order(...)`, `.maybeSingle()`, await).
         *
         * The select string is built at runtime from the config-sourced `embed`,
         * and the filter targets the embedded `org_id` via the dotted `filterKey`.
         * Builder data is untyped (`any`) for now (see the file header); the embedded
         * parent column is present only to drive the `!inner` org filter. The returned
         * builder is the real, chainable, org-scoped read builder.
         */
        select(columns: string = "*") {
          // Cast the runtime embed string to `"*"` so the select-string parser stays
          // on its cheap untyped path (see tenantDb.select); the real embed reaches
          // PostgREST at runtime to drive the `!inner` join + org filter.
          return supabaseAdmin
            .from(table)
            .select(`${columns}, ${embed}` as "*")
            .eq(filterKey, orgId);
        },
      };
    },
  };
}
