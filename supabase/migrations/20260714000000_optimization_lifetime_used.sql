-- Free tier gets ONE lifetime Optimization Run (#181 follow-up): the plan's
-- included run-count no longer resets each billing period for plans whose
-- grant is lifetime-scoped (PLANS[plan].optimizationRunsGrant in
-- src/lib/billing/plans.ts — currently just Free).
--
-- The ledger stays period-bucketed and untouched; lifetime consumption is a
-- read-side sum across ALL periods: 'reserve' spends a unit, 'release' hands
-- it back (a run that never executed a Rollout releases on settle — see
-- settle_optimization_run — so a run that failed before doing any work does
-- NOT consume the lifetime slot). getOptimizationAllowance subtracts this
-- from the plan's included count before writing the current period's grant,
-- so a Team that consumed its lifetime unit gets a zero grant in every later
-- period. Mirrors managed_spend_reserved_total's read-side-only shape.
CREATE OR REPLACE FUNCTION "public"."optimization_lifetime_used"("p_org_id" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(sum(
    case entry_type when 'reserve' then units when 'release' then -units else 0 end
  ), 0)
  from optimization_run_ledger
  where org_id = p_org_id;
$$;

ALTER FUNCTION "public"."optimization_lifetime_used"("p_org_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."optimization_lifetime_used"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."optimization_lifetime_used"("p_org_id" "uuid") TO "service_role";

revoke all on function public.optimization_lifetime_used(p_org_id uuid) from anon;
revoke all on function public.optimization_lifetime_used(p_org_id uuid) from authenticated;
