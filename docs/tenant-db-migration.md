# Tenant-scoped query helper — migration checklist (#207, finished #381)

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
`update()`/`delete()` pre-constrain by org, and `count()` does the same for a
head-only `{ count: "exact" }` read (added in #381 — `select()`'s column-varargs
signature has no room for a trailing options object).

## Scoping classes

Not every tenant table is filtered the same way. Two patterns exist in the app
code; the helper models both, in two functions.

### A. Directly `org_id`-scoped — `tenantDb(ctx)` (finished, #381)

These tables have an `org_id` column and the app filters them with
`.eq("org_id", …)`. **All four are fully migrated**: every call site that holds
an `AuthContext` (server actions *and* RSC page components — the page reads
that used to stay on the raw client are now ctx-driven too) goes through
`tenantDb(ctx).from(table)`.

- [x] `rubrics` — `src/app/actions/rubrics.ts`, `src/app/actions/{schedules,optimizations,eval-runs}.ts`
  (ownership checks), every RSC page that lists/reads rubrics.
- [x] `connections` — `src/app/actions/connections.ts`, `src/app/actions/{schedules,optimizations}.ts`.
  The one remaining direct write is the inline-create insert in
  `src/lib/connections/create.ts`, which stamps a **trusted `orgId` param**
  (not a `ctx`) — a deliberate, justified exception (see that file's note).
- [x] `schedules` — `src/app/actions/schedules.ts`, every RSC page that lists schedules.
- [x] `optimization_runs` — `src/app/actions/optimizations.ts`, `src/app/actions/connections.ts`
  (active-run / settlement checks keyed on a connection id).
- [ ] `provider_keys` — **out of scope by design**, see the SCOPE BOUNDARY note
  in `TENANT_SCOPED_TABLES` (tenant-db.ts): reached only through deep
  `orgId: string`-param lib functions, not a `ctx`.

**Justified exceptions that stay on the raw admin client** (each carries an
`eslint-disable-next-line no-restricted-syntax -- <reason>`, per the lint guard
below):

- **PostgREST embed selects** — `tenantDb`'s typed `select(...columns)` can't
  express a join. `getSchedule` (`schedules!inner`/`connections!inner`),
  `listOptimizationRuns`/`getOptimizationRun` (`connections!inner`/`rubrics!inner`)
  stay raw, still org-filtered by an explicit `.eq("org_id", orgId)`.
- **No-`ctx` claim path** — `src/lib/billing/claim-gate.ts` runs from a
  Temporal Activity with only a claimed run id, before any `AuthContext`
  exists; it resolves the org FROM the claimed row instead.
- **Trusted-`orgId`-param libs** — `src/lib/connections/create.ts` (inline
  Connection insert) stamps a caller-verified `orgId` directly.
- **User-scoped GDPR export** — `src/app/actions/data-rights.ts` reads
  `rubrics` by `created_by` (a user, not the active org) by design (ADR-0010).

### B. Parent-scoped via a join (`parentScoped(ctx)`)

These tables have **no `org_id` of their own**; they are scoped through a parent
FK chain that eventually reaches an `org_id`. They are modelled by
`parentScoped(ctx).from(table).select(columns)` in `tenant-db.ts`, whose
single-source `CLASS_B_PARENT_SCOPE` map encodes each table's `!inner` embed
string + dotted org-filter key. PostgREST embeds the parent(s) with `!inner` (an
inner join, so a child whose parent is in another org drops out) and filters on
the embedded `org_id`, e.g. for `optimization_inputs`:
`.select("<cols>, optimization_runs!inner(org_id)").eq("optimization_runs.org_id", orgId)`;
for a 2-hop like `eval_run_rows`:
`.select("<cols>, eval_runs!inner(rubrics!inner(org_id))").eq("eval_runs.rubrics.org_id", orgId)`.

Class-B tables are **not** in scope for the enforcement guard below (#381):
the guard covers exactly `TENANT_SCOPED_TABLES` (class-A), the tuple named in
the issue. Migrating class-B call sites onto `parentScoped` — and deciding
whether/how to guard them — is a separate follow-up.

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

## Enforcement guard (#381)

Finishing the migration only removes today's leaks; the ESLint
`no-restricted-syntax` rule in `eslint.tenant-guard.mjs` is what stops a new one
from being written. It bans `supabaseAdmin.from("<table>")` for exactly the
`TENANT_GUARD_TABLES` list — kept identical to `TENANT_SCOPED_TABLES` by the
parity test `src/lib/supabase/__tests__/tenant-lint-guard.test.ts` — anywhere in
`src/**` outside this module. A genuinely-can't-use-the-seam site (embed select,
no-`ctx` claim path, trusted-param lib, user-scoped export) needs an
`eslint-disable-next-line no-restricted-syntax -- <reason>` naming which
exception it is; see the exceptions list above for the four that exist today.
`e2e/authz.spec.ts` is the runtime backstop for the same bug class (symmetric
cross-tenant list/detail probes, Team A ↔ Team B).

## Migration recipe (per table)

1. Add the table name to `TENANT_SCOPED_TABLES` in `src/lib/supabase/tenant-db.ts`
   **and** `TENANT_GUARD_TABLES` in `eslint.tenant-guard.mjs` (the parity test
   fails until both move together).
2. Swap `supabaseAdmin.from(table)…` for `tenantDb(ctx).from(table)…` at each
   call site, dropping the now-redundant `org_id` from inserts and the
   `.eq("org_id", …)` from reads/updates/deletes.
3. Keep any non-org chain (`.eq("id", …)`, `.order(…)`, joins) unchanged. A site
   that needs an embed/join, has no `ctx` (only a trusted `orgId` or nothing at
   all), or is intentionally cross-org (the GDPR export) stays on the raw
   client with a justified `eslint-disable-next-line`.
4. Add/adjust the isolation test (cross-org read returns nothing; insert lands
   under ctx's org), mirroring `src/lib/supabase/__tests__/tenant-db.test.ts`.
