-- Voice Agent tables (multitenant: scoped by website_id, prefixed va_)
-- Server routes check public.is_admin() and then use the service role, so RLS
-- below is defense in depth: only admins of the row's website can touch it.

-- 1. Agent configuration: one row per website
create table if not exists public.va_agent_configs (
  website_id uuid primary key references public.websites(id) on delete cascade,
  retell_agent_id text not null,
  retell_llm_id text not null,
  retell_kb_id text,
  agent_name text not null default 'Customer Support',
  voice_id text not null default '11labs-Adrian',
  voice_speed numeric not null default 1.0 check (voice_speed between 0.5 and 2.0),
  begin_message text not null default 'Hi there! How can I help you today?',
  general_prompt text not null default 'You are a helpful customer support agent. Use the knowledge base to answer questions accurately and concisely.',
  updated_at timestamptz not null default now()
);

-- 2. Knowledge base documents
create table if not exists public.va_agent_documents (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  file_name text not null,
  file_size int not null,
  storage_path text not null,
  retell_source_id text,
  status text not null default 'indexing' check (status in ('indexing', 'ready', 'error')),
  created_at timestamptz not null default now()
);

create index if not exists va_agent_documents_website_idx
  on public.va_agent_documents (website_id, created_at desc);

-- 3. RLS
alter table public.va_agent_configs enable row level security;
alter table public.va_agent_documents enable row level security;

drop policy if exists "Website admins manage va_agent_configs" on public.va_agent_configs;
create policy "Website admins manage va_agent_configs" on public.va_agent_configs
  for all to authenticated
  using (public.is_admin(website_id, auth.uid()))
  with check (public.is_admin(website_id, auth.uid()));

drop policy if exists "Website admins manage va_agent_documents" on public.va_agent_documents;
create policy "Website admins manage va_agent_documents" on public.va_agent_documents
  for all to authenticated
  using (public.is_admin(website_id, auth.uid()))
  with check (public.is_admin(website_id, auth.uid()));

-- 4. Storage: private "knowledge-docs" bucket (created via API on 2026-10-29).
--    Objects live under "<website_id>/..."; only the service role reads/writes them
--    (the browser uploads through short-lived signed upload URLs issued by the server).
insert into storage.buckets (id, name, public, file_size_limit)
values ('knowledge-docs', 'knowledge-docs', false, 10485760)
on conflict (id) do nothing;
