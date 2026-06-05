-- Prevent orphaned Vault secrets. A connection's credential lives in vault.secrets,
-- referenced only by connections.auth_secret_id (a plain uuid — no FK/cascade). Without
-- this, deleting a connection leaves its secret behind, complicating rotation/auditing.

-- 1) DB-level guarantee: when a connection row is deleted, delete its secret too.
--    Covers every row-deletion path — schedule-rollback cleanup, a future
--    delete-connection action, and org cascade deletes.
create or replace function public.connections_delete_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if old.auth_secret_id is not null then
    delete from vault.secrets where id = old.auth_secret_id;
  end if;
  return old;
end;
$$;

create trigger connections_delete_secret_trigger
  after delete on public.connections
  for each row
  execute function public.connections_delete_secret();

-- 2) App-level cleanup for the one case the trigger can't see: insertConnection
--    creates the secret BEFORE inserting the row, so a failed insert orphans the
--    secret with no row to trigger on. The server helper calls this to undo it.
create or replace function public.delete_connection_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  delete from vault.secrets where id = p_secret_id;
$$;

revoke execute on function public.delete_connection_secret(uuid) from public;
grant  execute on function public.delete_connection_secret(uuid) to service_role;
