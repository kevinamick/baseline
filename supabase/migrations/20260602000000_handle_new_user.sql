-- Mirror every new auth.users row into public.users, replacing the Clerk
-- `user.created` webhook that previously created this row.
--
-- #46 keeps public.users.id as `text` and stores the Supabase auth uuid as its
-- text value (no FK to auth.users). The uuid conversion + `references
-- auth.users(id) on delete cascade` + dropping the ::text cast below is deferred
-- to the orgs slice (#47), where the dependent FKs are repointed in one
-- greenfield reset.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id)
  values (new.id::text)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
