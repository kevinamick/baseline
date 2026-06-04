-- Member management (#51) lets an admin demote or remove members. The app-level
-- last-admin guard (count admins, refuse if <= 1) is a friendly pre-check, but
-- it's a check-then-act across two queries: two concurrent removals of two
-- *different* admins could each read count = 2, both pass, and leave the org
-- with zero admins. Enforce the "every org keeps at least one admin" invariant
-- at the DB so it holds under concurrency (mirrors the atomic claim in
-- acceptInvitation).
--
-- The trigger fires only on changes that strip an admin (DELETE of an admin row,
-- or UPDATE of an admin to a non-admin role). It locks the org's admin rows
-- first (FOR UPDATE) so concurrent transactions serialize, then counts the
-- admins that would remain afterward.
create or replace function public.enforce_min_one_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining int;
begin
  -- Non-admin rows, and admin updates that stay admin, can't violate it.
  if old.role <> 'admin' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then
    return new;
  end if;

  -- Exempt cascade deletes. Deleting an organization, or a user, legitimately
  -- removes its membership rows (incl. the last admin); the invariant only
  -- guards *direct*, app-driven changes where both the org and the user remain.
  -- During a cascade the parent row is already gone within this transaction.
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.organizations where id = old.org_id)
       or not exists (select 1 from public.users where id = old.user_id) then
      return old;
    end if;
  end if;

  -- Lock this org's admin rows so concurrent demotes/removes can't both read a
  -- stale count; once locked, count the admins other than the one being changed.
  perform 1
  from public.memberships
  where org_id = old.org_id and role = 'admin'
  for update;

  select count(*) into remaining
  from public.memberships
  where org_id = old.org_id and role = 'admin' and user_id <> old.user_id;

  if remaining = 0 then
    raise exception 'organization % must keep at least one admin', old.org_id
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger memberships_min_one_admin
  before update or delete on public.memberships
  for each row execute function public.enforce_min_one_admin();
