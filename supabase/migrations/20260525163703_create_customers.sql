create table public.customers (
  clerk_user_id          text primary key
    references public.users(id) on delete cascade,
  stripe_customer_id     text unique not null,
  stripe_subscription_id text,
  email                  text,
  updated_at             timestamptz not null default now()
);

create index customers_subscription_id_idx
  on public.customers(stripe_subscription_id);

alter table public.customers enable row level security;
