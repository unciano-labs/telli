-- Voice Agent: (1) plans priced in USD, paid in PHP at the day's rate through PayMongo;
-- (2) agent modules: reservations (services, opening hours, appointments) and short-term
-- rentals (apartments, stays). The agent checks availability and books during the call
-- through Retell custom functions (/api/agent-tools).

-- 1. USD pricing --------------------------------------------------------------------------
alter table public.va_plans drop constraint if exists va_plans_currency_check;
alter table public.va_plans alter column currency set default 'USD';

-- Prices in US cents
update public.va_plans set currency = 'USD', price_cents = 3900, overage_cents_per_minute = 40, updated_at = now()
where website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f' and code = 'starter';
update public.va_plans set currency = 'USD', price_cents = 9900, overage_cents_per_minute = 40, updated_at = now()
where website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f' and code = 'growth';
update public.va_plans set currency = 'USD', price_cents = 24900, overage_cents_per_minute = 40, updated_at = now()
where website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f' and code = 'business';
-- Any other website's plans move to USD too, so the check below holds for every row
update public.va_plans set currency = 'USD' where currency <> 'USD';
alter table public.va_plans add constraint va_plans_currency_check check (currency = 'USD');

-- A payment is priced in USD (amount_cents, line_items) and charged in PHP at the day's rate.
-- Payments made before this migration were priced and charged in PHP.
alter table public.va_payments
  add column if not exists charged_currency text not null default 'PHP',
  add column if not exists charged_amount_cents int,
  add column if not exists exchange_rate numeric(12, 4);

update public.va_payments set charged_amount_cents = amount_cents where charged_amount_cents is null and currency = 'PHP';
alter table public.va_payments alter column currency set default 'USD';

-- 2. Modules ------------------------------------------------------------------------------
create extension if not exists btree_gist;

create table if not exists public.va_workspace_modules (
  website_id uuid not null,
  workspace_id uuid not null,
  module text not null check (module in ('reservations', 'rentals')),
  enabled boolean not null default true,
  -- reservations: { timezone, currency, slot_minutes, capacity, hours: { mon: [{start,end}], ... } }
  -- rentals:      { timezone, currency, check_in_time, check_out_time }
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, module),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

-- What the business offers: services (reservations)
create table if not exists public.va_services (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 1000),
  duration_minutes int not null check (duration_minutes between 5 and 480),
  price_cents int check (price_cents >= 0),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

-- Apartments / units (short-term rentals)
create table if not exists public.va_rentals (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 2000),
  address text check (char_length(address) <= 300),
  nightly_price_cents int not null check (nightly_price_cents >= 0),
  max_guests int not null default 2 check (max_guests between 1 and 50),
  bedrooms int check (bedrooms between 0 and 50),
  amenities text check (char_length(amenities) <= 1000),
  rules text check (char_length(rules) <= 2000),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

-- Appointments and stays
create table if not exists public.va_bookings (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  kind text not null check (kind in ('appointment', 'stay')),
  service_id uuid,
  rental_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  customer_name text not null check (char_length(customer_name) between 1 and 120),
  customer_phone text check (char_length(customer_phone) <= 40),
  guests int check (guests between 1 and 50),
  notes text check (char_length(notes) <= 1000),
  total_cents int check (total_cents >= 0),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  -- 'call' (the agent booked it), 'manual' (the team added it)
  source text not null default 'call' check (source in ('call', 'manual')),
  retell_call_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'appointment' and service_id is not null) or (kind = 'stay' and rental_id is not null)),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade,
  foreign key (service_id, workspace_id) references public.va_services (id, workspace_id) on delete restrict,
  foreign key (rental_id, workspace_id) references public.va_rentals (id, workspace_id) on delete restrict,
  -- No double booking of a unit. Appointments allow several at once (capacity), checked in va_book_appointment.
  constraint va_bookings_no_overlapping_stays exclude using gist
    (rental_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed' and kind = 'stay')
);

create index if not exists va_bookings_workspace_idx on public.va_bookings (workspace_id, starts_at);
create index if not exists va_services_workspace_idx on public.va_services (workspace_id, sort);
create index if not exists va_rentals_workspace_idx on public.va_rentals (workspace_id, sort);

-- RLS: members read their workspace's rows; writes go through the server (service role)
alter table public.va_workspace_modules enable row level security;
alter table public.va_services enable row level security;
alter table public.va_rentals enable row level security;
alter table public.va_bookings enable row level security;

drop policy if exists "Members read va_workspace_modules" on public.va_workspace_modules;
create policy "Members read va_workspace_modules" on public.va_workspace_modules
  for select to authenticated using (public.va_is_workspace_member(workspace_id));
drop policy if exists "Members read va_services" on public.va_services;
create policy "Members read va_services" on public.va_services
  for select to authenticated using (public.va_is_workspace_member(workspace_id));
drop policy if exists "Members read va_rentals" on public.va_rentals;
create policy "Members read va_rentals" on public.va_rentals
  for select to authenticated using (public.va_is_workspace_member(workspace_id));
drop policy if exists "Members read va_bookings" on public.va_bookings;
create policy "Members read va_bookings" on public.va_bookings
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

-- Books an appointment if fewer than p_capacity confirmed appointments overlap it. The lock makes
-- check-then-insert safe when two callers want the same slot. Returns null when it's full.
create or replace function public.va_book_appointment(
  p_website_id uuid,
  p_workspace_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_capacity int,
  p_customer_name text,
  p_customer_phone text,
  p_guests int,
  p_notes text,
  p_total_cents int,
  p_source text,
  p_retell_call_id text,
  p_created_by uuid
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('va_book_appointment:' || p_workspace_id::text));
  if (
    select count(*) from public.va_bookings
    where website_id = p_website_id and workspace_id = p_workspace_id
      and kind = 'appointment' and status = 'confirmed'
      and tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
  ) >= greatest(p_capacity, 1) then
    return null;
  end if;
  insert into public.va_bookings
    (website_id, workspace_id, kind, service_id, starts_at, ends_at, customer_name, customer_phone,
     guests, notes, total_cents, source, retell_call_id, created_by)
  values
    (p_website_id, p_workspace_id, 'appointment', p_service_id, p_starts_at, p_ends_at, p_customer_name, p_customer_phone,
     p_guests, p_notes, p_total_cents, p_source, p_retell_call_id, p_created_by)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.va_book_appointment(uuid, uuid, uuid, timestamptz, timestamptz, int, text, text, int, text, int, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.va_book_appointment(uuid, uuid, uuid, timestamptz, timestamptz, int, text, text, int, text, int, text, text, uuid)
  to service_role;
