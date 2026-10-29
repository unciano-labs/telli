-- Voice Agent Phase 5: phone numbers per workspace. A number is bought through Retell
-- (US/CA), bought through our Twilio account and imported into Retell over our SIP trunk,
-- or brought by the customer (their own SIP trunk, imported into Retell). Inbound calls
-- reach the workspace's published agent; outbound calls use the workspace's own numbers.

create table if not exists public.va_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  provider text not null check (provider in ('retell', 'twilio', 'byo')),
  -- Twilio IncomingPhoneNumber SID (provider twilio)
  provider_sid text,
  -- ISO 3166-1 alpha-2
  country text not null check (country ~ '^[A-Z]{2}$'),
  nickname text check (char_length(nickname) <= 60),
  inbound_enabled boolean not null default true,
  outbound_enabled boolean not null default true,
  -- Countries this number may call (also set on the Retell number)
  outbound_countries text[] not null default '{}',
  -- What it costs us per month (null when unknown)
  monthly_price_cents int check (monthly_price_cents >= 0),
  status text not null default 'active' check (status in ('active', 'released')),
  purchased_at timestamptz not null default now(),
  released_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  released_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

-- A number belongs to one workspace at a time (the Retell account is shared by all of them)
create unique index if not exists va_phone_numbers_active_e164
  on public.va_phone_numbers (e164) where status = 'active';
create index if not exists va_phone_numbers_workspace_idx
  on public.va_phone_numbers (workspace_id, created_at);

alter table public.va_phone_numbers enable row level security;

drop policy if exists "Members read va_phone_numbers" on public.va_phone_numbers;
create policy "Members read va_phone_numbers" on public.va_phone_numbers
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

-- The platform workspace keeps the Twilio number it already calls out from. It was set up by
-- hand with no inbound agent, so inbound starts off.
insert into public.va_phone_numbers
  (website_id, workspace_id, e164, provider, country, nickname, inbound_enabled, outbound_enabled, outbound_countries)
select c.website_id, c.workspace_id, c.retell_phone_number, 'twilio', 'US', 'Voice Agent demo (Twilio)', false, true, '{PH,US}'
from public.va_agent_configs c
join public.va_workspaces w on w.id = c.workspace_id and w.website_id = c.website_id
where w.is_platform and c.retell_phone_number is not null
on conflict (e164) where status = 'active' do nothing;
