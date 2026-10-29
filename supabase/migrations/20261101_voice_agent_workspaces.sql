-- Voice Agent Phase 3: workspaces (one per customer business) inside the Voice Agent website.
-- Every va_ row now belongs to a workspace; the website stays the tenant in the shared project.
-- The existing agent, documents, widgets and calls move into a "platform" workspace that
-- website admins own (it also runs the landing-page dialer and the public demo).

-- 1. Workspaces
create table if not exists public.va_workspaces (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  template text,
  -- Plans arrive with billing (Phase 6); until then everything is a trial or activated by hand
  plan text not null default 'trial',
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended')),
  -- Talk time a trial workspace may use across test, widget and outbound calls
  trial_seconds int not null default 600 check (trial_seconds between 0 and 360000),
  is_platform boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, slug),
  -- Target for the composite foreign keys below: a row's workspace must be on the row's website
  unique (id, website_id)
);

create unique index if not exists va_workspaces_platform_idx
  on public.va_workspaces (website_id) where is_platform;

-- 2. Members
create table if not exists public.va_workspace_members (
  workspace_id uuid not null references public.va_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists va_workspace_members_user_idx on public.va_workspace_members (user_id);

-- 3. Invites: only a hash of the link token is stored
create table if not exists public.va_workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.va_workspaces(id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);

create unique index if not exists va_workspace_invites_open_idx
  on public.va_workspace_invites (workspace_id, email) where accepted_at is null;

-- 4. Platform workspace for the existing agent; website admins become its owners
insert into public.va_workspaces (website_id, name, slug, status, plan, is_platform)
select 'c8b2b438-d3d9-4ec9-8493-768a2476241f', 'Voice Agent', 'voice-agent', 'active', 'internal', true
where not exists (
  select 1 from public.va_workspaces
  where website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f' and is_platform
);

insert into public.va_workspace_members (workspace_id, user_id, role)
select w.id, p.user_id, 'owner'
from public.va_workspaces w
join public.website_roles wr on wr.website_id = w.website_id and wr.role = 'admin'
join public.user_roles ur on ur.website_role_id = wr.id
join public.user_profiles p on p.id = ur.user_profile_id
where w.is_platform and w.website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f'
on conflict do nothing;

-- 5. workspace_id on every per-business table, backfilled to the platform workspace
do $$
declare
  t text;
  v_platform uuid;
begin
  select id into v_platform from public.va_workspaces
  where website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f' and is_platform;

  foreach t in array array['va_agent_configs', 'va_agent_documents', 'va_call_logs', 'va_widgets', 'va_widget_events']
  loop
    execute format('alter table public.%I add column if not exists workspace_id uuid', t);
    execute format('update public.%I set workspace_id = %L where workspace_id is null and website_id = %L',
      t, v_platform, 'c8b2b438-d3d9-4ec9-8493-768a2476241f');
    execute format('alter table public.%I alter column workspace_id set not null', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_workspace_fkey');
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id, website_id) '
      'references public.va_workspaces (id, website_id) on delete cascade',
      t, t || '_workspace_fkey');
  end loop;
end $$;

-- One agent config per workspace (was one per website)
alter table public.va_agent_configs drop constraint if exists va_agent_configs_pkey;
alter table public.va_agent_configs add primary key (workspace_id);
create index if not exists va_agent_configs_website_idx on public.va_agent_configs (website_id);
-- Webhooks and inbound calls are matched to a workspace by agent
create unique index if not exists va_agent_configs_agent_idx on public.va_agent_configs (retell_agent_id);

create index if not exists va_agent_documents_workspace_idx
  on public.va_agent_documents (workspace_id, created_at desc);
create index if not exists va_call_logs_workspace_idx
  on public.va_call_logs (workspace_id, created_at desc);
create index if not exists va_widgets_workspace_idx
  on public.va_widgets (workspace_id, created_at);
create index if not exists va_widget_events_workspace_idx
  on public.va_widget_events (workspace_id, created_at desc);

-- 6. Access helpers for RLS. They read auth.uid() themselves so they can't be used to
--    probe other users' memberships. Website admins (platform staff) see every workspace.
create or replace function public.va_workspace_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.va_workspaces w
      where w.id = p_workspace_id and public.is_admin(w.website_id, auth.uid())
    ) then 'owner'
    else (
      select m.role from public.va_workspace_members m
      where m.workspace_id = p_workspace_id and m.user_id = auth.uid()
    )
  end
$$;

create or replace function public.va_is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select public.va_workspace_role(p_workspace_id) is not null
$$;

revoke execute on function public.va_workspace_role(uuid) from public, anon;
revoke execute on function public.va_is_workspace_member(uuid) from public, anon;
grant execute on function public.va_workspace_role(uuid) to authenticated, service_role;
grant execute on function public.va_is_workspace_member(uuid) to authenticated, service_role;

-- 7. RLS: members can read their workspace's rows. All writes go through the server
--    (service role) after it checks the member's role, so there are no write policies.
alter table public.va_workspaces enable row level security;
alter table public.va_workspace_members enable row level security;
alter table public.va_workspace_invites enable row level security;

drop policy if exists "Members read va_workspaces" on public.va_workspaces;
create policy "Members read va_workspaces" on public.va_workspaces
  for select to authenticated using (public.va_is_workspace_member(id));

drop policy if exists "Members read va_workspace_members" on public.va_workspace_members;
create policy "Members read va_workspace_members" on public.va_workspace_members
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Workspace admins read va_workspace_invites" on public.va_workspace_invites;
create policy "Workspace admins read va_workspace_invites" on public.va_workspace_invites
  for select to authenticated using (public.va_workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Website admins manage va_agent_configs" on public.va_agent_configs;
drop policy if exists "Members read va_agent_configs" on public.va_agent_configs;
create policy "Members read va_agent_configs" on public.va_agent_configs
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Website admins manage va_agent_documents" on public.va_agent_documents;
drop policy if exists "Members read va_agent_documents" on public.va_agent_documents;
create policy "Members read va_agent_documents" on public.va_agent_documents
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Website admins manage va_call_logs" on public.va_call_logs;
drop policy if exists "Members read va_call_logs" on public.va_call_logs;
create policy "Members read va_call_logs" on public.va_call_logs
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Website admins manage va_widgets" on public.va_widgets;
drop policy if exists "Members read va_widgets" on public.va_widgets;
create policy "Members read va_widgets" on public.va_widgets
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Website admins read va_widget_events" on public.va_widget_events;
drop policy if exists "Members read va_widget_events" on public.va_widget_events;
create policy "Members read va_widget_events" on public.va_widget_events
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

-- 8. Create a workspace and its owner in one step, capped per user
create or replace function public.va_create_workspace(
  p_website_id uuid,
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_template text,
  p_max_owned int default 3
)
returns table (workspace_id uuid, error text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Serializes one user's creates so parallel requests can't pass the cap together
  perform pg_advisory_xact_lock(hashtext('va_ws_create:' || p_user_id::text));

  if (select count(*) from public.va_workspace_members m
      join public.va_workspaces w on w.id = m.workspace_id
      where m.user_id = p_user_id and m.role = 'owner' and w.website_id = p_website_id
        and not w.is_platform) >= p_max_owned then
    return query select null::uuid, 'limit'::text;
    return;
  end if;

  if exists (select 1 from public.va_workspaces where website_id = p_website_id and slug = p_slug) then
    return query select null::uuid, 'slug_taken'::text;
    return;
  end if;

  insert into public.va_workspaces (website_id, name, slug, template, created_by)
  values (p_website_id, p_name, p_slug, p_template, p_user_id)
  returning id into v_id;

  insert into public.va_workspace_members (workspace_id, user_id, role)
  values (v_id, p_user_id, 'owner');

  return query select v_id, null::text;
end;
$$;

-- 9. Talk time a workspace has used (for trial limits). Finished calls count their real
--    duration; calls still open in the last 15 minutes count as a full 5 minutes.
create or replace function public.va_workspace_usage(p_website_id uuid, p_workspace_id uuid)
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(
    case
      when l.status in ('ended', 'not_connected', 'error') then ceil(coalesce(l.duration_ms, 0) / 1000.0)
      when l.created_at > now() - interval '15 minutes' then 300
      else 0
    end
  ), 0)::int
  from public.va_call_logs l
  where l.website_id = p_website_id and l.workspace_id = p_workspace_id
$$;

-- 10. Members with their profile, for the team page
create or replace function public.va_workspace_member_list(p_website_id uuid, p_workspace_id uuid)
returns table (user_id uuid, email text, full_name text, role text, joined_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select m.user_id, p.email, p.full_name, m.role, m.created_at
  from public.va_workspace_members m
  join public.va_workspaces w on w.id = m.workspace_id and w.website_id = p_website_id
  left join lateral (
    select up.email, up.full_name from public.user_profiles up
    where up.user_id = m.user_id and up.deleted_at is null
    order by up.created_at
    limit 1
  ) p on true
  where m.workspace_id = p_workspace_id
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at
$$;

-- 11. Accept an invite: the link token and the signed-in email must both match
create or replace function public.va_accept_invite(
  p_website_id uuid,
  p_token_hash text,
  p_user_id uuid,
  p_email text
)
returns table (workspace_slug text, error text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invite public.va_workspace_invites;
  v_slug text;
begin
  select i.* into v_invite
  from public.va_workspace_invites i
  join public.va_workspaces w on w.id = i.workspace_id and w.website_id = p_website_id
  where i.token_hash = p_token_hash
  for update of i;

  if not found or v_invite.accepted_at is not null then
    return query select null::text, 'invalid'::text;
    return;
  end if;
  if v_invite.expires_at < now() then
    return query select null::text, 'expired'::text;
    return;
  end if;
  if v_invite.email <> lower(p_email) then
    return query select null::text, 'email_mismatch'::text;
    return;
  end if;

  -- Joining never lowers an existing role
  insert into public.va_workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, p_user_id, v_invite.role)
  on conflict (workspace_id, user_id) do update
    set role = case
      when public.va_workspace_members.role = 'owner' then 'owner'
      when excluded.role = 'admin' then 'admin'
      else public.va_workspace_members.role
    end;

  update public.va_workspace_invites
  set accepted_at = now(), accepted_by = p_user_id
  where id = v_invite.id;

  select slug into v_slug from public.va_workspaces where id = v_invite.workspace_id;
  return query select v_slug, null::text;
end;
$$;

-- 12. Platform console: every workspace with its owner and recent usage
create or replace function public.va_platform_workspaces(p_website_id uuid, p_since timestamptz)
returns table (
  id uuid,
  name text,
  slug text,
  status text,
  plan text,
  is_platform boolean,
  trial_seconds int,
  created_at timestamptz,
  owner_email text,
  members bigint,
  widgets bigint,
  documents bigint,
  calls bigint,
  seconds bigint,
  cost_cents numeric,
  total_seconds int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    w.id, w.name, w.slug, w.status, w.plan, w.is_platform, w.trial_seconds, w.created_at,
    (select p.email from public.va_workspace_members m
       join public.user_profiles p on p.user_id = m.user_id and p.deleted_at is null
       where m.workspace_id = w.id and m.role = 'owner'
       order by m.created_at limit 1),
    (select count(*) from public.va_workspace_members m where m.workspace_id = w.id),
    (select count(*) from public.va_widgets x where x.workspace_id = w.id),
    (select count(*) from public.va_agent_documents x where x.workspace_id = w.id),
    coalesce(u.calls, 0),
    coalesce(u.seconds, 0),
    coalesce(u.cost_cents, 0),
    public.va_workspace_usage(p_website_id, w.id)
  from public.va_workspaces w
  left join lateral (
    select count(*) as calls,
      (coalesce(sum(l.duration_ms), 0) / 1000)::bigint as seconds,
      coalesce(sum(l.cost_cents), 0) as cost_cents
    from public.va_call_logs l
    where l.workspace_id = w.id and l.created_at >= p_since and l.source <> 'test'
  ) u on true
  where w.website_id = p_website_id
  order by w.is_platform desc, w.created_at desc
$$;

-- 13. Analytics, now per workspace (replaces the per-website versions)
drop function if exists public.va_usage_daily(uuid, timestamptz, text, uuid);
drop function if exists public.va_widget_funnel(uuid, timestamptz, uuid);

create or replace function public.va_usage_daily(
  p_website_id uuid,
  p_workspace_id uuid,
  p_since timestamptz,
  p_tz text default 'Asia/Manila',
  p_widget_id uuid default null
)
returns table (day date, source text, calls bigint, connected bigint, seconds bigint, cost_cents numeric)
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
    and l.workspace_id = p_workspace_id
    and l.created_at >= p_since
    and (p_widget_id is null or l.widget_id = p_widget_id)
  group by 1, 2
  order by 1, 2
$$;

create or replace function public.va_widget_funnel(
  p_website_id uuid,
  p_workspace_id uuid,
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
    and e.workspace_id = p_workspace_id
    and e.created_at >= p_since
    and (p_widget_id is null or e.widget_id = p_widget_id)
  group by e.event
$$;

-- Server-only (service role): the server checks the caller's workspace role first
revoke execute on function public.va_create_workspace(uuid, uuid, text, text, text, int) from public, anon, authenticated;
revoke execute on function public.va_workspace_usage(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.va_workspace_member_list(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.va_accept_invite(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.va_platform_workspaces(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.va_usage_daily(uuid, uuid, timestamptz, text, uuid) from public, anon, authenticated;
revoke execute on function public.va_widget_funnel(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.va_create_workspace(uuid, uuid, text, text, text, int) to service_role;
grant execute on function public.va_workspace_usage(uuid, uuid) to service_role;
grant execute on function public.va_workspace_member_list(uuid, uuid) to service_role;
grant execute on function public.va_accept_invite(uuid, text, uuid, text) to service_role;
grant execute on function public.va_platform_workspaces(uuid, timestamptz) to service_role;
grant execute on function public.va_usage_daily(uuid, uuid, timestamptz, text, uuid) to service_role;
grant execute on function public.va_widget_funnel(uuid, uuid, timestamptz, uuid) to service_role;
