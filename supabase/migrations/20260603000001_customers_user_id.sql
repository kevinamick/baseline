-- Billing cutover (#49): customers is keyed by the Supabase user id now.
--
-- #47 retyped this column to uuid and FK'd it to public.users but kept the Clerk
-- name (`clerk_user_id`) to scope that change. Finish the rename here so the
-- schema reflects the Supabase identity. Greenfield — no row backfill.
alter table public.customers rename column clerk_user_id to user_id;

alter table public.customers
  rename constraint customers_clerk_user_id_fkey to customers_user_id_fkey;
