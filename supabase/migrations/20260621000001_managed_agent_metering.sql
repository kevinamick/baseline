-- Managed Agent metering (#291). A Managed Agent (#290) runs the target model on the
-- managed key, so its rollout inference is now metered managed spend — the dominant term
-- in an optimization run. Those accruals land on managed_spend_ledger with a new call_kind,
-- 'agent', distinct from the existing 'judge' / 'reflect' so the ledger stays auditable by
-- which model call drove the cost. Widen the column CHECK to admit it.
--
-- The original CHECK is the inline column constraint from 20260613000001, whose Postgres
-- auto-name is managed_spend_ledger_call_kind_check. Drop and re-add (append-only data is
-- untouched; existing rows are all 'judge' / 'reflect' / null and still satisfy the new set).
alter table public.managed_spend_ledger
  drop constraint if exists managed_spend_ledger_call_kind_check;

alter table public.managed_spend_ledger
  add constraint managed_spend_ledger_call_kind_check
  check (call_kind is null or call_kind in ('judge', 'reflect', 'agent'));
