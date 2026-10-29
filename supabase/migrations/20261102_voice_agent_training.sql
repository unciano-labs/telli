-- Voice Agent Phase 4 (part 1): training studio. Business profile, FAQs, team rules,
-- draft/publish with version history, and test cases. Knowledge (documents, FAQs, web
-- pages) lives in the Retell knowledge base and applies immediately; prompt and voice
-- changes go to a draft agent version that callers only hear after Publish.

-- 1. Agent config: how the prompt is built, and which Retell version callers hear
alter table public.va_agent_configs
  add column if not exists profile jsonb not null default '{}'::jsonb,
  add column if not exists prompt_mode text not null default 'advanced'
    check (prompt_mode in ('profile', 'advanced')),
  -- Advanced mode: the owner's own prompt (platform rules are always added on top)
  add column if not exists custom_prompt text,
  -- Published agent version every live call is pinned to; null until versioning starts
  add column if not exists live_version int,
  add column if not exists published_at timestamptz,
  add column if not exists draft_changed_at timestamptz;

-- Existing agents keep their hand-written prompt as the Advanced prompt
update public.va_agent_configs
set custom_prompt = general_prompt
where custom_prompt is null;

-- 2. FAQ entries, each synced to one Retell knowledge base text source
create table if not exists public.va_agent_faqs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  question text not null check (char_length(question) between 1 and 300),
  alternates text[] not null default '{}',
  answer text not null check (char_length(answer) between 1 and 2000),
  retell_source_id text,
  status text not null default 'syncing' check (status in ('syncing', 'ready', 'error')),
  origin text not null default 'manual' check (origin in ('manual', 'correction', 'unanswered')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_faqs_workspace_idx on public.va_agent_faqs (workspace_id, created_at desc);

-- 3. Rules the team adds to the prompt ("Never quote delivery dates")
create table if not exists public.va_agent_rules (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  rule text not null check (char_length(rule) between 1 and 500),
  origin text not null default 'manual' check (origin in ('manual', 'correction')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_rules_workspace_idx on public.va_agent_rules (workspace_id, created_at);

-- 4. Change log: draft edits, publishes and rollbacks (with a snapshot to roll back to)
create table if not exists public.va_agent_changes (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  action text not null check (action in ('edit', 'publish', 'rollback')),
  -- Edits to the prompt/voice change the draft; knowledge edits (FAQs, pages, files) are live at once
  scope text not null default 'draft' check (scope in ('draft', 'live')),
  -- Retell agent version that was published (publish / rollback)
  version int,
  summary text not null,
  -- Prompt-side settings at publish time, restored on rollback
  snapshot jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_changes_workspace_idx on public.va_agent_changes (workspace_id, created_at desc);

-- 5. Test cases (Retell simulation tests) and their runs
create table if not exists public.va_agent_test_cases (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  -- What the simulated caller does, e.g. "Ask whether you can get a refund after 10 days"
  caller text not null check (char_length(caller) between 1 and 1000),
  -- What a good answer does, e.g. "Mentions the 7-day refund policy"
  expectation text not null check (char_length(expectation) between 1 and 500),
  retell_definition_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_test_cases_workspace_idx on public.va_agent_test_cases (workspace_id, created_at);

create table if not exists public.va_agent_test_runs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  retell_batch_id text not null unique,
  -- Draft agent version the run tested; a later draft edit makes the run stale
  agent_version int not null,
  status text not null default 'running' check (status in ('running', 'complete')),
  pass_count int not null default 0,
  fail_count int not null default 0,
  error_count int not null default 0,
  total_count int not null default 0,
  -- Per test case: { test_case_id, name, status, explanation }
  results jsonb not null default '[]'::jsonb,
  draft_changed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_test_runs_workspace_idx on public.va_agent_test_runs (workspace_id, created_at desc);

-- 6. RLS: members read their workspace's rows; writes go through the server (service role)
alter table public.va_agent_faqs enable row level security;
alter table public.va_agent_rules enable row level security;
alter table public.va_agent_changes enable row level security;
alter table public.va_agent_test_cases enable row level security;
alter table public.va_agent_test_runs enable row level security;

drop policy if exists "Members read va_agent_faqs" on public.va_agent_faqs;
create policy "Members read va_agent_faqs" on public.va_agent_faqs
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Members read va_agent_rules" on public.va_agent_rules;
create policy "Members read va_agent_rules" on public.va_agent_rules
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Members read va_agent_changes" on public.va_agent_changes;
create policy "Members read va_agent_changes" on public.va_agent_changes
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Members read va_agent_test_cases" on public.va_agent_test_cases;
create policy "Members read va_agent_test_cases" on public.va_agent_test_cases
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Members read va_agent_test_runs" on public.va_agent_test_runs;
create policy "Members read va_agent_test_runs" on public.va_agent_test_runs
  for select to authenticated using (public.va_is_workspace_member(workspace_id));
