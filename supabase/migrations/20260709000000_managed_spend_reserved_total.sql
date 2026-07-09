-- #470: surface the split the Managed Spend Cap gate already computes.
--
-- reserve_managed_spend sums reserve + accrue - release to decide the cap
-- (worker/AGENTS.md, ADR-0008 Meter 2); managed_spend_total only ever exposed
-- the accrue half (actual spend). This adds the OTHER half a Team needs to
-- read its own in-flight exposure: outstanding reservations for runs that
-- haven't accrued/released yet. Read-side only — no reserve/accrue/release
-- semantics change, this just names a sum those functions already maintain.
--
-- Mirrors release_managed_reservation's per-run outstanding computation
-- (reserve - release), scoped to the whole org+period instead of one run:
-- a reservation is released in full when its run settles (see that
-- function), so the org-wide sum naturally goes to zero once nothing is
-- in flight.
CREATE OR REPLACE FUNCTION "public"."managed_spend_reserved_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) RETURNS numeric
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(sum(
    case entry_type when 'reserve' then amount_usd when 'release' then -amount_usd else 0 end
  ), 0)
  from managed_spend_ledger
  where org_id = p_org_id and period_start = p_period_start;
$$;

ALTER FUNCTION "public"."managed_spend_reserved_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."managed_spend_reserved_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."managed_spend_reserved_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "service_role";

revoke all on function public.managed_spend_reserved_total(p_org_id uuid, p_period_start timestamp with time zone) from anon;
revoke all on function public.managed_spend_reserved_total(p_org_id uuid, p_period_start timestamp with time zone) from authenticated;
