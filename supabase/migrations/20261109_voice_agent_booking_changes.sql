-- Voice Agent: callers can change or cancel their stay through the agent (after proving the
-- booking with its reference and mobile number), following the workspace's policy. Each change
-- is recorded on the booking.
alter table public.va_bookings
  add column if not exists cancelled_at timestamptz,
  -- What the cancellation policy charges (0 = free cancellation)
  add column if not exists cancellation_fee_cents int check (cancellation_fee_cents >= 0),
  -- [{ at, by: 'call' | 'manual', action: 'changed' | 'cancelled', summary }]
  add column if not exists history jsonb not null default '[]'::jsonb;

-- Booking references callers can say easily: 6 digits, unique within the workspace, set by the
-- database on every insert (agent, team and appointments alike).
alter table public.va_bookings
  add column if not exists reference text check (reference ~ '^[0-9]{6}$');

create or replace function public.va_booking_reference()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_reference text;
begin
  if new.reference is not null then
    return new;
  end if;
  loop
    v_reference := (100000 + floor(random() * 900000))::int::text;
    exit when not exists (
      select 1 from public.va_bookings where workspace_id = new.workspace_id and reference = v_reference
    );
  end loop;
  new.reference := v_reference;
  return new;
end;
$$;

drop trigger if exists va_bookings_reference on public.va_bookings;
create trigger va_bookings_reference
  before insert on public.va_bookings
  for each row execute function public.va_booking_reference();

-- Existing bookings get one too
do $$
declare
  r record;
  v_reference text;
begin
  for r in select id, workspace_id from public.va_bookings where reference is null loop
    loop
      v_reference := (100000 + floor(random() * 900000))::int::text;
      exit when not exists (
        select 1 from public.va_bookings where workspace_id = r.workspace_id and reference = v_reference
      );
    end loop;
    update public.va_bookings set reference = v_reference where id = r.id;
  end loop;
end;
$$;

create unique index if not exists va_bookings_reference_idx on public.va_bookings (workspace_id, reference);
