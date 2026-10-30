-- Voice Agent: richer apartment records for short-term rentals.
--   va_rentals.code / details: public (the agent may tell any caller).
--   va_rental_private.guest_info: given by the agent only to a caller who proves a confirmed
--     booking (reference + phone) from 24 hours before check-in until check-out.
--   va_rental_private.internal_notes: the team only, never sent to the agent.
-- Private details are readable by owners and admins only, not regular members.

alter table public.va_rentals
  add column if not exists code text check (char_length(code) <= 40),
  add column if not exists details text check (char_length(details) <= 6000);

-- Euro for businesses outside the Philippines/US (e.g. Cyprus rentals)
-- (module settings are jsonb, so no constraint changes are needed there)

create table if not exists public.va_rental_private (
  rental_id uuid primary key,
  website_id uuid not null,
  workspace_id uuid not null,
  guest_info text check (char_length(guest_info) <= 6000),
  internal_notes text check (char_length(internal_notes) <= 6000),
  updated_at timestamptz not null default now(),
  foreign key (rental_id, workspace_id) references public.va_rentals (id, workspace_id) on delete cascade,
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

alter table public.va_rental_private enable row level security;

drop policy if exists "Admins read va_rental_private" on public.va_rental_private;
create policy "Admins read va_rental_private" on public.va_rental_private
  for select to authenticated using (public.va_workspace_role(workspace_id) in ('owner', 'admin'));
