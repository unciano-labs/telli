-- Voice Agent Phase 2: public demo with a per-user talk-time allowance and a daily budget

-- 1. Demo settings (one row per website) + the dedicated Retell demo agent
create table if not exists public.va_demo_settings (
  website_id uuid primary key references public.websites(id) on delete cascade,
  enabled boolean not null default true,
  seconds_per_user int not null default 300 check (seconds_per_user between 30 and 3600),
  daily_budget_minutes int not null default 120 check (daily_budget_minutes between 0 and 100000),
  contact_url text,
  retell_agent_id text,
  retell_llm_id text,
  retell_webhook_url text,
  updated_at timestamptz not null default now()
);

alter table public.va_demo_settings enable row level security;

drop policy if exists "Website admins manage va_demo_settings" on public.va_demo_settings;
create policy "Website admins manage va_demo_settings" on public.va_demo_settings
  for all to authenticated
  using (public.is_admin(website_id, auth.uid()))
  with check (public.is_admin(website_id, auth.uid()));

-- 2. Demo sessions: a reservation of talk time, linked to its call once Retell creates it
create table if not exists public.va_demo_sessions (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario text not null,
  allotted_seconds int not null check (allotted_seconds > 0),
  retell_call_id text unique,
  -- reserved: before Retell answered; started: call created; failed: never created (costs nothing)
  status text not null default 'reserved' check (status in ('reserved', 'started', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists va_demo_sessions_user_idx
  on public.va_demo_sessions (website_id, user_id, created_at desc);
create index if not exists va_demo_sessions_day_idx
  on public.va_demo_sessions (website_id, created_at desc);

alter table public.va_demo_sessions enable row level security;

drop policy if exists "Website admins read va_demo_sessions" on public.va_demo_sessions;
create policy "Website admins read va_demo_sessions" on public.va_demo_sessions
  for select to authenticated
  using (public.is_admin(website_id, auth.uid()));

-- 3. Seconds each session counts against allowances.
--    Finished call -> real duration. Unfinished or not yet linked -> the full reservation,
--    so a call in progress can't be used to start a second one. Stuck sessions stop
--    blocking new calls after 15 minutes (a demo call is capped at 5) but still count.
create or replace function public.va_demo_session_usage(p_website_id uuid)
returns table (
  session_id uuid,
  user_id uuid,
  scenario text,
  created_at timestamptz,
  seconds int,
  is_open boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    d.id,
    d.user_id,
    d.scenario,
    d.created_at,
    case
      when d.status = 'failed' then 0
      when l.status in ('ended', 'not_connected', 'error') then ceil(coalesce(l.duration_ms, 0) / 1000.0)::int
      else d.allotted_seconds
    end,
    d.status <> 'failed'
      and (l.id is null or l.status in ('registered', 'ongoing'))
      and d.created_at > now() - interval '15 minutes'
  from public.va_demo_sessions d
  left join public.va_call_logs l
    on l.website_id = d.website_id and l.retell_call_id = d.retell_call_id
  where d.website_id = p_website_id
$$;

-- 4. Atomically reserve talk time for one demo call.
--    Returns (session_id, allotted_seconds, error); error is one of
--    disabled | in_progress | allowance_used | daily_budget.
create or replace function public.va_demo_reserve(
  p_website_id uuid,
  p_user_id uuid,
  p_scenario text,
  p_max_call_seconds int,
  p_tz text default 'Asia/Manila'
)
returns table (session_id uuid, allotted_seconds int, error text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_settings public.va_demo_settings;
  v_user_used int;
  v_day_used int;
  v_open boolean;
  v_allot int;
  v_id uuid;
begin
  -- One reservation at a time per website: keeps the per-user and daily totals exact
  perform pg_advisory_xact_lock(hashtext('va_demo:' || p_website_id::text));

  select * into v_settings from public.va_demo_settings where website_id = p_website_id;
  if not found or not v_settings.enabled then
    return query select null::uuid, 0, 'disabled'::text;
    return;
  end if;

  select
    coalesce(sum(u.seconds) filter (where u.user_id = p_user_id), 0),
    coalesce(sum(u.seconds) filter (
      where (u.created_at at time zone p_tz)::date = (now() at time zone p_tz)::date
    ), 0),
    coalesce(bool_or(u.is_open) filter (where u.user_id = p_user_id), false)
  into v_user_used, v_day_used, v_open
  from public.va_demo_session_usage(p_website_id) u;

  if v_open then
    return query select null::uuid, 0, 'in_progress'::text;
    return;
  end if;

  v_allot := least(
    v_settings.seconds_per_user - v_user_used,
    v_settings.daily_budget_minutes * 60 - v_day_used,
    p_max_call_seconds
  );
  -- Under 15 seconds isn't a useful call
  if v_settings.seconds_per_user - v_user_used < 15 then
    return query select null::uuid, 0, 'allowance_used'::text;
    return;
  end if;
  if v_allot < 15 then
    return query select null::uuid, 0, 'daily_budget'::text;
    return;
  end if;

  insert into public.va_demo_sessions (website_id, user_id, scenario, allotted_seconds)
  values (p_website_id, p_user_id, p_scenario, v_allot)
  returning id into v_id;

  return query select v_id, v_allot, null::text;
end;
$$;

-- 5. A user's allowance, using the same accounting as va_demo_reserve (for the demo page)
create or replace function public.va_demo_status(
  p_website_id uuid,
  p_user_id uuid,
  p_tz text default 'Asia/Manila'
)
returns table (
  enabled boolean,
  seconds_per_user int,
  used_seconds int,
  in_progress boolean,
  budget_left_seconds int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(s.enabled, false),
    coalesce(s.seconds_per_user, 0),
    coalesce((select sum(u.seconds) from public.va_demo_session_usage(p_website_id) u
              where u.user_id = p_user_id), 0)::int,
    coalesce((select bool_or(u.is_open) from public.va_demo_session_usage(p_website_id) u
              where u.user_id = p_user_id), false),
    greatest(coalesce(s.daily_budget_minutes, 0) * 60
      - coalesce((select sum(u.seconds) from public.va_demo_session_usage(p_website_id) u
                  where (u.created_at at time zone p_tz)::date = (now() at time zone p_tz)::date), 0), 0)::int
  from (select 1) one
  left join public.va_demo_settings s on s.website_id = p_website_id
$$;

-- 6. Leads: everyone enrolled in the website, with their demo activity
create or replace function public.va_demo_leads(p_website_id uuid)
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  joined_at timestamptz,
  demo_calls bigint,
  demo_seconds bigint,
  scenarios text[],
  last_demo_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with usage as (
    select u.user_id, count(*) as calls, sum(u.seconds) as seconds,
      array_agg(distinct u.scenario) as scenarios, max(u.created_at) as last_at
    from public.va_demo_session_usage(p_website_id) u
    group by u.user_id
  )
  select
    p.user_id,
    p.email,
    p.full_name,
    wr.role,
    ur.created_at,
    coalesce(us.calls, 0),
    coalesce(us.seconds, 0),
    coalesce(us.scenarios, '{}'),
    us.last_at
  from public.website_roles wr
  join public.user_roles ur on ur.website_role_id = wr.id
  join public.user_profiles p on p.id = ur.user_profile_id
  left join usage us on us.user_id = p.user_id
  where wr.website_id = p_website_id
    and p.deleted_at is null
  order by coalesce(us.last_at, ur.created_at) desc
$$;

-- Server-only (service role): these read every user's activity
revoke execute on function public.va_demo_session_usage(uuid) from public, anon, authenticated;
revoke execute on function public.va_demo_reserve(uuid, uuid, text, int, text) from public, anon, authenticated;
revoke execute on function public.va_demo_leads(uuid) from public, anon, authenticated;
revoke execute on function public.va_demo_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.va_demo_session_usage(uuid) to service_role;
grant execute on function public.va_demo_reserve(uuid, uuid, text, int, text) to service_role;
grant execute on function public.va_demo_leads(uuid) to service_role;
grant execute on function public.va_demo_status(uuid, uuid, text) to service_role;

-- 7. Default settings row for Voice Agent
insert into public.va_demo_settings (website_id)
values ('c8b2b438-d3d9-4ec9-8493-768a2476241f')
on conflict (website_id) do nothing;
