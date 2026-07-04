import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Database } from "./database.types";
import type { AuthContext } from "@/lib/auth/context";

type Tables = Database["public"]["Tables"];

// A minimal, org-scoped READ builder over the untyped client. It carries the (possibly
// projected) Row type so results are schema-typed WITHOUT instantiating the typed Supabase
// client — which is a measured tsc-memory bomb (a lean typed-client variant OOMed at a 4 GB
// heap; this stays <700 MB). Awaiting it yields `{ data: Row[] }`; `.single()`/`.maybeSingle()`
// yield `{ data: Row | null }`. Filter-column args are `string` (you may filter by a column you
// didn't select), but the RESULT rows are typed to exactly what was selected. This is an
// intentionally small surface: if a migrated read needs another builder method, add it here —
// a missing method is a compile error, never a silent `any`.
interface ScopedRead<Row> extends PromiseLike<{ data: Row[] | null; error: PostgrestError | null }> {
  eq(column: string, value: unknown): ScopedRead<Row>;
  neq(column: string, value: unknown): ScopedRead<Row>;
  in(column: string, values: readonly unknown[]): ScopedRead<Row>;
  gte(column: string, value: unknown): ScopedRead<Row>;
  lte(column: string, value: unknown): ScopedRead<Row>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): ScopedRead<Row>;
  limit(count: number): ScopedRead<Row>;
  single(): Promise<{ data: Row | null; error: PostgrestError | null }>;
  maybeSingle(): Promise<{ data: Row | null; error: PostgrestError | null }>;
}

// A head-only count read (PostgREST's `{ count: "exact", head: true }` — no rows
// back, just a count), org-scoped the same way `ScopedRead` is. Kept as its own
// tiny builder rather than folded into `select()`'s column-varargs signature,
// which has no room for a trailing options object.
interface ScopedCount extends PromiseLike<{ count: number | null; error: PostgrestError | null }> {
  eq(column: string, value: unknown): ScopedCount;
  in(column: string, values: readonly unknown[]): ScopedCount;
}

// The Row type a `select(...columns)` yields: the full table Row when no columns are passed,
// otherwise just the projected columns. `[K] extends [never]` distinguishes the no-arg call.
type Projected<Table extends keyof Tables, K extends keyof Tables[Table]["Row"]> = [K] extends [never]
  ? Tables[Table]["Row"]
  : Pick<Tables[Table]["Row"], K>;

/**
 * Helper-scoped typing decision (#207).
 *
 * (a) of this PR LANDS the generated schema (`database.types.ts`, committed +
 * eslint-ignored) and consumes it where it's CHEAP and high-value:
 *
 *   - WRITES are schema-typed. `insert`/`update` take `Omit<…Insert/Update, "org_id">`,
 *     so a wrong/misspelled/mistyped column is a COMPILE error, and `org_id` is absent
 *     from the caller's type — it can only come from `ctx` (the runtime strip below is
 *     belt-and-suspenders). These are plain indexed-access types, so they add ~no tsc cost.
 *
 *   - READS are schema-typed too, via `select()` returning a `ScopedRead<Row>`. `select()`
 *     yields the full Row; `select("id", "name")` type-checks the column names and yields
 *     `Pick<Row, "id" | "name">`, so reading an unselected column is a compile error.
 *
 * What we deliberately DON'T do is type the underlying Supabase CLIENT: threading the schema
 * through a `SupabaseClient<Database>` view + Supabase's `.select(<column-string>)` generic
 * parser is a measured `tsc` memory bomb — even a lean typed-read variant OOMed at a 4 GB
 * heap (peak ~4.3 GB), where this version peaks <700 MB. So we keep building on the untyped
 * client and apply the schema types at the helper's edges (the `Omit<…>` write params and the
 * `ScopedRead<Row>` cast). Globally typing `supabaseAdmin`'s ~70 call sites stays a separate
 * follow-up that has to solve the typed-client tsc cost first.
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
 *   - `count()`  same org filter, for a head-only `{ count: "exact" }` read
 *     (existence/active-work checks that don't need row data).
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
  // rubrics carries its own org_id (class-A). Fully migrated: every ctx-holding
  // call site (server actions + RSC pages) reads/writes it through this helper.
  "rubrics",
  // optimization_runs carries its own org_id (class-A). Fully migrated for every
  // ctx-holding call site. Two reads stay on the raw client with a justified
  // disable — listOptimizationRuns/getOptimizationRun pull a PostgREST embed
  // (`connections!inner(...)`, `rubrics!inner(...)`) the typed select(...columns)
  // can't express, mirroring getSchedule's embed read below (#381).
  "optimization_runs",
  // connections carries its own org_id (class-A). Fully migrated: every
  // ctx-holding read/update/delete goes through this helper; the inline-create
  // insert in lib/connections/create.ts is the one remaining direct write (it
  // stamps a trusted org_id param — see that file's note).
  "connections",
  // schedules carries its own org_id (class-A). Fully migrated for every
  // ctx-holding call site; getSchedule's embed read (rubrics!inner /
  // connections!inner) stays on the raw client — the typed select(...columns)
  // can't express embeds — but is org-filtered.
  "schedules",
  //
  // SCOPE BOUNDARY (decided #207 follow-up): tables reached only through deep
  // `orgId: string`-param lib functions — provider_keys (lib/llm/keys.ts,
  // key-gate.ts) and the billing/* helpers — stay on the raw admin client. They
  // already org-scope via an explicit `.eq("org_id", orgId)` on a trusted param,
  // and tenantDb is intentionally ctx-only (it owns org resolution, so it can't
  // take a bare orgId without weakening that). Those are NOT pending migrations.
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
    from<Table extends TenantScopedTable>(table: Table) {
      return {
        // Org-scoped read with schema-typed results. `select()` yields the full Row;
        // `select("id", "name")` projects — type-checked column names and a result typed
        // to exactly `Pick<Row, "id" | "name">`, so reading an unselected column is a
        // compile error. Runtime: the column names are joined into the PostgREST select
        // string; the `as "*"` keeps Supabase's (tsc-OOMing) select-string parser on its
        // cheap path while the typing comes from `ScopedRead`/`Projected` instead.
        select<K extends keyof Tables[Table]["Row"] = never>(
          ...columns: K[]
        ): ScopedRead<Projected<Table, K>> {
          const cols = columns.length ? columns.join(", ") : "*";
          return supabaseAdmin
            .from(table)
            .select(cols as "*")
            .eq("org_id", orgId) as unknown as ScopedRead<Projected<Table, K>>;
        },
        // Write PAYLOADS are schema-typed (cheap — just an indexed type, no typed
        // client): a wrong/missing column is a compile error, and `org_id` is omitted
        // from the caller's type so it can ONLY come from ctx (the runtime strip is
        // belt-and-suspenders). The runtime call uses the untyped client.
        insert(values: Omit<Tables[Table]["Insert"], "org_id">) {
          return supabaseAdmin
            .from(table)
            .insert({ ...stripOrgId(values as Record<string, unknown>), org_id: orgId });
        },
        // Org-scoped head count (no rows returned) — the `{ count: "exact", head: true }`
        // shape `select()` can't carry (its signature is column varargs, not a trailing
        // options object). Used for existence/active-work checks (e.g. "does this
        // connection have any active optimization runs") that only need a count.
        count<K extends keyof Tables[Table]["Row"]>(column: K): ScopedCount {
          return supabaseAdmin
            .from(table)
            .select(column as string, { count: "exact", head: true })
            .eq("org_id", orgId) as unknown as ScopedCount;
        },
        update(values: Omit<Tables[Table]["Update"], "org_id">) {
          return supabaseAdmin
            .from(table)
            .update(stripOrgId(values as Record<string, unknown>))
            .eq("org_id", orgId);
        },
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
