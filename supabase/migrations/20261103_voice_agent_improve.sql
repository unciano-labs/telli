-- Voice Agent Phase 4 (part 2): learn from real calls. Retell's post-call analysis tags
-- each call (resolved, unanswered questions, caller intent); unanswered questions land in
-- an inbox; wrong answers in a transcript become FAQ entries or rules; widget callers rate
-- the call. Members can suggest fixes; owners and admins apply them.

-- 1. Call log: analysis results, caller feedback and review state
alter table public.va_call_logs
  -- From Retell's custom analysis (the full result stays in `analysis`)
  add column if not exists resolved boolean,
  add column if not exists caller_intent text,
  -- 👍 / 👎 from the widget after the call
  add column if not exists feedback_rating text check (feedback_rating in ('up', 'down')),
  add column if not exists feedback_comment text check (char_length(feedback_comment) <= 1000),
  add column if not exists feedback_at timestamptz,
  -- Someone on the team looked at the call in the review queue
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;

create index if not exists va_call_logs_workspace_idx
  on public.va_call_logs (workspace_id, created_at desc);

-- 2. Questions the agent couldn't answer, one row per question per call
create table if not exists public.va_agent_questions (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  call_log_id uuid not null references public.va_call_logs(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 300),
  status text not null default 'open' check (status in ('open', 'answered', 'ignored')),
  faq_id uuid references public.va_agent_faqs(id) on delete set null,
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (call_log_id, question),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_questions_open_idx
  on public.va_agent_questions (workspace_id, created_at desc) where status = 'open';

-- 3. Fixes for wrong answers (from a transcript) and suggested answers (from the inbox).
-- Owners and admins apply at once; members' fixes wait as suggestions.
create table if not exists public.va_agent_corrections (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  call_log_id uuid references public.va_call_logs(id) on delete set null,
  -- Index of the agent reply in the call's transcript (null for inbox suggestions)
  position int,
  caller_said text check (char_length(caller_said) <= 2000),
  original_reply text check (char_length(original_reply) <= 4000),
  fix_type text not null check (fix_type in ('faq', 'rule')),
  -- FAQ question (fix_type faq)
  question text check (char_length(question) <= 300),
  -- FAQ answer, or the rule text
  correction text not null check (char_length(correction) between 1 and 2000),
  -- Inbox questions this answers; marked answered when it's applied
  question_ids uuid[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  faq_id uuid references public.va_agent_faqs(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_agent_corrections_workspace_idx
  on public.va_agent_corrections (workspace_id, created_at desc);

-- 4. RLS: members read their workspace's rows; writes go through the server (service role)
alter table public.va_agent_questions enable row level security;
alter table public.va_agent_corrections enable row level security;

drop policy if exists "Members read va_agent_questions" on public.va_agent_questions;
create policy "Members read va_agent_questions" on public.va_agent_questions
  for select to authenticated using (public.va_is_workspace_member(workspace_id));

drop policy if exists "Members read va_agent_corrections" on public.va_agent_corrections;
create policy "Members read va_agent_corrections" on public.va_agent_corrections
  for select to authenticated using (public.va_is_workspace_member(workspace_id));
