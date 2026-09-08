-- Compose-only init (runs after the Supabase image's own migrations, before ours): give the
-- PostgREST login role the stack password. The image creates `authenticator` but only sets
-- passwords for `postgres`/`supabase_admin`; supabase's own self-host bundle does the same
-- thing in its roles.sql.
\set pgpass `echo "$PGPASSWORD"`
alter user authenticator with password :'pgpass';

-- The image runs these init files as `supabase_admin`, so every pgmq queue table the
-- baseline migration creates (`pgmq.create('eval_runs')`) is owned by it. On hosted
-- Supabase the CLI applies migrations as `postgres`, which therefore owns the queue and
-- can read/update it from the SECURITY DEFINER `dequeue_eval_run_message` /
-- `ack_eval_run_message` functions (owned by `postgres`). Mirror that here: anything
-- `supabase_admin` creates in `pgmq` from now on is writable by `postgres`.
alter default privileges for role supabase_admin in schema pgmq
  grant all on tables to postgres;
alter default privileges for role supabase_admin in schema pgmq
  grant all on sequences to postgres;
