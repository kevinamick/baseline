-- Multi-org membership (#52): a user may now belong to several organizations and
-- switch the active one. Drop the single-owner constraint #47 added; the
-- (org_id, user_id) primary key still prevents joining the same org twice.
alter table public.memberships drop constraint if exists memberships_user_id_key;

-- The dropped unique index also backed getAuthContext's by-user_id lookup (the
-- (org_id, …) PK can't serve it). Keep a plain index so that read stays cheap.
create index if not exists memberships_user_id_idx on public.memberships (user_id);
