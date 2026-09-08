-- Compose-only init (runs after the Supabase image's own migrations, before ours): give the
-- PostgREST login role the stack password. The image creates `authenticator` but only sets
-- passwords for `postgres`/`supabase_admin`; supabase's own self-host bundle does the same
-- thing in its roles.sql.
\set pgpass `echo "$PGPASSWORD"`
alter user authenticator with password :'pgpass';
