-- Voice Agent Phase 1: embeddable widgets, widget events, and tracking for every call type

-- 1. Widgets (one row per embed snippet)
create table if not exists public.va_widgets (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  public_key text not null unique,
  name text not null,
  -- Sites allowed to embed the widget (CSP frame-ancestors), e.g. https://example.com or https://*.example.com
  allowed_origins text[] not null default '{}',
  title text not null default 'Voice support',
  button_label text not null default 'Talk to us',
  accent_color text not null default '#4f46e5' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  position text not null default 'right' check (position in ('right', 'left')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists va_widgets_website_idx on public.va_widgets (website_id, created_at);

alter table public.va_widgets enable row level security;

drop policy if exists "Website admins manage va_widgets" on public.va_widgets;
create policy "Website admins manage va_widgets" on public.va_widgets
  for all to authenticated
  using (public.is_admin(website_id, auth.uid()))
  with check (public.is_admin(website_id, auth.uid()));

-- 2. Call log: track web, widget, demo, test and inbound calls alongside outbound
alter table public.va_call_logs drop constraint if exists va_call_logs_direction_check;
alter table public.va_call_logs
  add constraint va_call_logs_direction_check check (direction in ('outbound', 'inbound', 'web'));

-- Existing rows are all outbound calls; the default backfills them, then is dropped
alter table public.va_call_logs
  add column if not exists source text not null default 'outbound'
    check (source in ('landing', 'widget', 'demo', 'test', 'outbound', 'inbound')),
  add column if not exists widget_id uuid references public.va_widgets(id) on delete set null,
  add column if not exists page_url text,
  add column if not exists visitor_id text,
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists cost_cents numeric(12, 4),
  add column if not exists user_sentiment text,
  add column if not exists call_successful boolean,
  add column if not exists analysis jsonb;

alter table public.va_call_logs alter column source drop default;

create index if not exists va_call_logs_widget_idx
  on public.va_call_logs (widget_id, created_at desc) where widget_id is not null;

-- 3. Widget funnel events (written by the server with the service role)
create table if not exists public.va_widget_events (
  id bigint generated always as identity primary key,
  website_id uuid not null references public.websites(id) on delete cascade,
  widget_id uuid not null references public.va_widgets(id) on delete cascade,
  event text not null check (event in ('loaded', 'opened', 'call_started', 'call_ended')),
  visitor_id text,
  page_url text,
  created_at timestamptz not null default now()
);

create index if not exists va_widget_events_website_idx
  on public.va_widget_events (website_id, created_at desc);

alter table public.va_widget_events enable row level security;

drop policy if exists "Website admins read va_widget_events" on public.va_widget_events;
create policy "Website admins read va_widget_events" on public.va_widget_events
  for select to authenticated
  using (public.is_admin(website_id, auth.uid()));

-- 4. Remember which webhook URL is registered on the Retell agent
alter table public.va_agent_configs
  add column if not exists retell_webhook_url text;

-- 5. Analytics. security invoker: RLS on the underlying tables still applies.
create or replace function public.va_usage_daily(
  p_website_id uuid,
  p_since timestamptz,
  p_tz text default 'Asia/Manila',
  p_widget_id uuid default null
)
returns table (
  day date,
  source text,
  calls bigint,
  connected bigint,
  seconds bigint,
  cost_cents numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (l.created_at at time zone p_tz)::date as day,
    l.source,
    count(*) as calls,
    count(*) filter (where coalesce(l.duration_ms, 0) > 0) as connected,
    (coalesce(sum(l.duration_ms), 0) / 1000)::bigint as seconds,
    coalesce(sum(l.cost_cents), 0) as cost_cents
  from public.va_call_logs l
  where l.website_id = p_website_id
    and l.created_at >= p_since
    and (p_widget_id is null or l.widget_id = p_widget_id)
  group by 1, 2
  order by 1, 2
$$;

create or replace function public.va_widget_funnel(
  p_website_id uuid,
  p_since timestamptz,
  p_widget_id uuid default null
)
returns table (event text, events bigint, visitors bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select e.event, count(*) as events, count(distinct e.visitor_id) as visitors
  from public.va_widget_events e
  where e.website_id = p_website_id
    and e.created_at >= p_since
    and (p_widget_id is null or e.widget_id = p_widget_id)
  group by e.event
$$;

revoke execute on function public.va_usage_daily(uuid, timestamptz, text, uuid) from public, anon;
revoke execute on function public.va_widget_funnel(uuid, timestamptz, uuid) from public, anon;
grant execute on function public.va_usage_daily(uuid, timestamptz, text, uuid) to authenticated, service_role;
grant execute on function public.va_widget_funnel(uuid, timestamptz, uuid) to authenticated, service_role;
