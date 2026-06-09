-- Pause-and-wait on endpoint outage (#102), part 1 of 2: the new 'paused' status.
--
-- ALTER TYPE ... ADD VALUE may run inside a transaction (PG 12+), but the new value cannot
-- be USED in the same transaction that adds it. Each migration file runs in its own
-- transaction, so the value is added here and first referenced (partial unique index, status
-- writes) in the follow-up migration.
alter type public.optimization_run_status add value if not exists 'paused' before 'completed';
