// Lint side of the tenant-isolation guard (#207).
//
// The app runs service-role-everything: `supabaseAdmin` bypasses RLS, so a raw
// query on a tenant-scoped table with a forgotten `.eq("org_id", …)` is a silent
// cross-tenant leak. `tenantDb(ctx)` (src/lib/supabase/tenant-db.ts) makes the org
// filter structural — this rule makes reaching around it a lint error.
//
// TENANT_GUARD_TABLES must stay identical to TENANT_SCOPED_TABLES in tenant-db.ts.
// ESLint config runs under plain Node and can't import that TS module, so the list
// is duplicated here and held in lockstep by a parity test
// (src/lib/supabase/__tests__/tenant-lint-guard.test.ts) — the same pattern as the
// app↔worker model registry.
export const TENANT_GUARD_TABLES = [
  "rubrics",
  "optimization_runs",
  "connections",
  "schedules",
];

const tablesPattern = TENANT_GUARD_TABLES.join("|");

export const tenantGuardRestriction = {
  selector: `CallExpression[callee.object.name='supabaseAdmin'][callee.property.name='from'] > Literal[value=/^(${tablesPattern})$/]`,
  message:
    "Raw supabaseAdmin on a tenant-scoped table bypasses the structural org_id guard — use tenantDb(ctx) from @/lib/supabase/tenant-db. If this site genuinely can't (PostgREST embed select, trusted orgId param, parent-scoped guard with no ctx), add an eslint-disable-next-line stating the reason.",
};
