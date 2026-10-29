-- Voice Agent outbound calling: caller ID + greeting settings and a call log

-- 1. Outbound settings on the per-website config
alter table public.va_agent_configs
  add column if not exists retell_phone_number text,
  add column if not exists outbound_begin_message text not null
    default 'Hi {{customer_name}}, this is {{agent_name}} calling about {{reason}}. Is now a good time to talk?';

-- 2. Call log (outbound calls started from /admin)
create table if not exists public.va_call_logs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  retell_call_id text not null unique,
  direction text not null default 'outbound' check (direction in ('outbound', 'web')),
  from_number text,
  to_number text,
  customer_name text,
  reason text,
  initiated_by uuid references auth.users(id) on delete set null,
  status text not null default 'registered'
    check (status in ('registered', 'not_connected', 'ongoing', 'ended', 'error')),
  disconnection_reason text,
  duration_ms int,
  summary text,
  transcript text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists va_call_logs_website_idx
  on public.va_call_logs (website_id, created_at desc);

alter table public.va_call_logs enable row level security;

drop policy if exists "Website admins manage va_call_logs" on public.va_call_logs;
create policy "Website admins manage va_call_logs" on public.va_call_logs
  for all to authenticated
  using (public.is_admin(website_id, auth.uid()))
  with check (public.is_admin(website_id, auth.uid()));
