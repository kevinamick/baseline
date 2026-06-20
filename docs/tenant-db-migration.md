# Tenant-scoped query helper — migration checklist (#207)

The app runs a **service-role-everything** model: all table I/O goes through
`supabaseAdmin` (`src/lib/supabase/admin.ts`), which **bypasses RLS by design**
(see `supabase/migrations/20260614000000_service_role_table_grants.sql`). The
27 app tables enable RLS with **no policy**, so there is no DB backstop — tenant
isolation lives entirely in app code, where every query on a tenant-scoped table
must remember `.eq("org_id", ctx.orgId)`. One forgotten filter is a silent
cross-tenant leak.

`src/lib/supabase/tenant-db.ts` (`tenantDb(ctx)`) makes the org filter
**structural** instead of something you have to remember: `select()` pre-applies
the org filter, `insert()` stamps `org_id` (and strips any caller-supplied one),
`update()`/`delete()` pre-constrain by org. **`rubrics` is migrated end-to-end**
as the tracer slice (`src/app/actions/rubrics.ts`).

## Scoping classes

Not every tenant table is filtered the same way today. Two patterns exist in the
app code, and the helper currently only models the first:

### A. Directly `org_id`-scoped (the helper handles these as-is)

These tables have an `org_id` column and the app filters them with
`.eq("org_id", …)`. They migrate to `tenantDb(ctx).from(table)` with no API
change:

- [x] `rubrics` — **migrated** (`getRubric`, `createRubric`, `updateRubric`, `deleteRubric`)
- [ ] `connections` — `src/app/actions/connections.ts` (7 org_id filters), `src/lib/connections/create.ts`
- [ ] `schedules` — `src/app/actions/schedules.ts` (direct org_id reads/writes)
- [~] `optimization_runs` — **partially migrated**: the in-flight-runs read in
  `deleteRubric` now goes through `tenantDb` (#207 tracer / #255). The
  `src/app/actions/optimizations.ts` reads/writes still migrate incrementally.
- [ ] `provider_keys` — `src/app/actions/provider-keys.ts`, `src/lib/llm/*`

### B. Parent-scoped via a join (`parentScoped(ctx)`)

These tables have **no `org_id` of their own**; they are scoped through a parent
FK chain that eventually reaches an `org_id`. They are now modelled by
`parentScoped(ctx).from(table).select(columns)` in `tenant-db.ts`, whose
single-source `CLASS_B_PARENT_SCOPE` map encodes each table's `!inner` embed
string + dotted org-filter key. PostgREST embeds the parent(s) with `!inner` (an
inner join, so a child whose parent is in another org drops out) and filters on
the embedded `org_id`, e.g. for `optimization_inputs`:
`.select("<cols>, optimization_runs!inner(org_id)").eq("optimization_runs.org_id", orgId)`;
for a 2-hop like `eval_run_rows`:
`.select("<cols>, eval_runs!inner(rubrics!inner(org_id))").eq("eval_runs.rubrics.org_id", orgId)`.

- [x] `eval_runs` — scoped via `rubric_id` → `rubrics.org_id` **(read path used by `deleteRubric` settle, #255)**
- [ ] `eval_run_rows` — child of `eval_runs` (2-hop)
- [ ] `eval_run_results` — child of `eval_runs` (2-hop)
- [ ] `optimization_candidates` — child of `optimization_runs` (1-hop)
- [ ] `optimization_inputs` — child of `optimization_runs` (1-hop)
- [ ] `optimization_rollouts` — child of `optimization_candidates` → `optimization_runs` (2-hop)
- [ ] `rollout_results` — child of `optimization_rollouts` → … → `optimization_runs` (3-hop)
- [ ] `schedule_inputs` — child of `schedules` (1-hop)

> **Class-B is READ-ONLY in this helper, by design.** PostgREST cannot filter an
> UPDATE/DELETE by an embedded/joined column, so there is no honest way to scope
> a class-B *write* in a single statement — faking it would reintroduce exactly
> the cross-tenant footgun the helper removes. `parentScoped` therefore exposes
> only `select`. Class-B writes happen in two trusted ways that don't need an
> org filter on the write itself: (1) the **parent cascade** (deleting a
> `rubrics` row removes its `eval_runs`/rows/results), and (2) the **Temporal
> worker** inside an already-org-validated workflow (it resolved the parent's org
> before touching the child). If an app-side scoped class-B write is ever truly
> needed, do it as an explicit **two-step**: resolve org-owned ids via
> `parentScoped(...).select("id")`, then write with `.in("id", ids)` against
> those resolved ids — never a single statement pretending to filter by a joined
> column.

### Out of scope (not multi-tenant by `org_id`, stay on the raw admin client)

- `memberships` — keyed by `user_id` (+ a `(org_id, user_id)` PK); membership
  lookups are by user, not a tenant read.
- `users`, `organizations`, `worker_config`, `rate_limit_hits` — not org-row-owned
  the same way.
- Billing/ledger tables (`customers`, `invitations`, `point_ledger`,
  `managed_spend_ledger`, `optimization_run_ledger`, `*_invoice_lines`,
  `paid_invoices`, `billing_*`) — append-only or billing-owned; several are
  reserve/settle ledgers (ADR-0009) and should not get blanket update/delete via
  this helper. Evaluate case by case before pulling any into the tenant helper.

## Non-app-code readers of migrated tables (deliberately left raw)

The helper is server-action-facing. These read the same tables but are not
`AuthContext`-driven, so they stay on the raw admin client for now and are listed
for completeness:

- `src/app/[locale]/rubrics/page.tsx`, `…/rubrics/[id]/page.tsx`,
  `…/dashboard/page.tsx`, `…/optimizations/page.tsx`, `…/schedules/page.tsx`
  — RSC page reads (already carry their own `.eq("org_id", …)`).
- `worker/src/**` — the Temporal worker reads `rubrics`/`connections` by id
  inside an org-validated workflow; out of scope for the app-side helper.

## Migration recipe (per table)

1. Add the table name to `TENANT_SCOPED_TABLES` in `src/lib/supabase/tenant-db.ts`.
2. Swap `supabaseAdmin.from(table)…` for `tenantDb(ctx).from(table)…` at each
   call site, dropping the now-redundant `org_id` from inserts and the
   `.eq("org_id", …)` from reads/updates/deletes.
3. Keep any non-org chain (`.eq("id", …)`, `.order(…)`, joins) unchanged.
4. Add/adjust the isolation test (cross-org read returns nothing; insert lands
   under ctx's org), mirroring `src/lib/supabase/__tests__/tenant-db.test.ts`.
