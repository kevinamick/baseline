-- Local dev seed. Mirrors the Clerk users/organizations that the
-- `clerk` webhook would normally create, so FK-constrained inserts
-- (rubrics, connections, schedules — all reference these tables) work
-- against the local Supabase database without a live webhook.
--
-- These rows match the shared Clerk *development* instance. Re-run is safe
-- (on conflict do nothing); `supabase db reset` re-applies this file.

insert into public.users (id) values
  ('user_3EEIr0RcdnO1zL95C9t35dnXXZq'),
  ('user_3EEv52qZmMYYRULCUEaRFdWl8wn'),
  ('user_3EVJilravdy5jFrmSCm1DqbyYcz')
on conflict (id) do nothing;

insert into public.organizations (id) values
  ('org_3EVJmnYOX5KYCtqWXko1qsjW48j'),
  ('org_3EMnasJKwu6TdEE9tFAQkSqBuoV'),
  ('org_3EJUvquyfmMnaMofD9HlNx0BNIz'),
  ('org_3EJUuF10ZgUWDR3lEHmBOIewcfX')
on conflict (id) do nothing;
