-- Voice Agent: a demo scenario can call a real workspace's published agent instead of the
-- sample business (e.g. the short-term rental scenario uses a real rental workspace, with its
-- apartments and calendar). Map of scenario id -> workspace id, set in Platform -> Demo.
alter table public.va_demo_settings
  add column if not exists scenario_workspaces jsonb not null default '{}'::jsonb;
