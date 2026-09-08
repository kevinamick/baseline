-- Compose-only init, mounted LAST (`zz-99`) so it runs after every repo migration.
--
-- The image runs these init files as `supabase_admin`, so every pgmq queue table the
-- baseline migration creates (`pgmq.create('eval_runs')`) is owned by it. On hosted
-- Supabase the CLI applies migrations as `postgres`, which therefore owns the queue and
-- can read/update it from the SECURITY DEFINER `dequeue_eval_run_message` /
-- `ack_eval_run_message` functions (owned by `postgres`). Mirror that here for the queue
-- tables that exist now, and for any queue a later migration creates.
grant all on all tables in schema pgmq to postgres;
grant all on all sequences in schema pgmq to postgres;
alter default privileges for role supabase_admin in schema pgmq
  grant all on tables to postgres;
alter default privileges for role supabase_admin in schema pgmq
  grant all on sequences to postgres;
