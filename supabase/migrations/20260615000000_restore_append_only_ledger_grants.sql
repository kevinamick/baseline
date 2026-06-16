-- Restore the append-only invariant on the usage ledgers (ADR-0009).
--
-- The ledgers are append-only by REVOKE, not just convention: point_ledger
-- (20260612000000), optimization_run_ledger (20260612000002), and
-- managed_spend_ledger (20260613000001) each did
--   revoke update, delete, truncate ... from service_role;
-- so a "settle"/"release" is a NEW row, never a mutation — the ledger a customer
-- inspects IS the audit trail (ADR-0008's transparency principle).
--
-- 20260614000000_service_role_table_grants.sql then ran, to fix Supabase's
-- Data-API breaking change:
--   grant select, insert, update, delete on all tables in schema public to service_role;
-- That bulk grant silently RE-GRANTED update + delete on these three ledgers,
-- breaking the append-only guarantee for the (RLS-bypassing) service role the app
-- runs as. It's invisible in CI (the *.integration.test.ts append-only checks are
-- skipped without a local Supabase env), so it slipped through.
--
-- Re-revoke the write verbs from service_role on the append-only ledgers,
-- AFTER the bulk grant, restoring immutability. INSERT + SELECT stay (the app
-- appends rows and reads them). Future tables are unaffected: the bulk grant was
-- a one-time statement; 20260614's `alter default privileges` only governs tables
-- created later, and a NEW append-only table would re-state its own revoke.
--
-- TRUNCATE was never re-granted (the bulk grant didn't include it), but we
-- re-revoke it too so the three ledgers' grant state is uniform and self-evident.

revoke update, delete, truncate on public.point_ledger            from service_role;
revoke update, delete, truncate on public.optimization_run_ledger from service_role;
revoke update, delete, truncate on public.managed_spend_ledger    from service_role;
