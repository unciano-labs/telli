-- Voice Agent Phase 6: plans, prepaid monthly billing (PayMongo Checkout) and usage limits.
-- A workspace pays for one month of a plan at a time. Calls stop when the plan's minutes
-- run out or the paid month ends; nothing is charged automatically.

-- 1. Plans (per website). Prices in PHP centavos per month.
create table if not exists public.va_plans (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  code text not null check (code ~ '^[a-z][a-z0-9_]{1,30}$' and code <> 'trial'),
  name text not null check (char_length(name) between 1 and 40),
  description text check (char_length(description) <= 300),
  price_cents int not null check (price_cents >= 0),
  currency text not null default 'PHP' check (currency = 'PHP'),
  included_minutes int not null check (included_minutes >= 0),
  -- Not charged yet: calls stop at the limit
  overage_cents_per_minute int check (overage_cents_per_minute >= 0),
  max_widgets int not null check (max_widgets >= 0),
  max_numbers int not null check (max_numbers >= 0),
  max_documents int not null check (max_documents >= 0),
  max_faqs int not null check (max_faqs >= 0),
  max_pages int not null check (max_pages >= 0),
  outbound_allowed boolean not null default false,
  ai_suggestions boolean not null default false,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, code)
);

-- Server-only (service role): no policies
alter table public.va_plans enable row level security;

insert into public.va_plans
  (website_id, code, name, description, price_cents, included_minutes, overage_cents_per_minute,
   max_widgets, max_numbers, max_documents, max_faqs, max_pages, outbound_allowed, ai_suggestions, sort)
values
  ('c8b2b438-d3d9-4ec9-8493-768a2476241f', 'starter', 'Starter', 'For a small business answering questions on its website.',
   249000, 100, 2500, 1, 1, 10, 50, 5, false, false, 1),
  ('c8b2b438-d3d9-4ec9-8493-768a2476241f', 'growth', 'Growth', 'More minutes, more widgets, and outbound calls.',
   599000, 300, 2500, 3, 2, 30, 100, 25, true, false, 2),
  ('c8b2b438-d3d9-4ec9-8493-768a2476241f', 'business', 'Business', 'For busy teams with several lines and websites.',
   1499000, 800, 2500, 10, 3, 100, 200, 25, true, true, 3)
on conflict (website_id, code) do nothing;

-- 2. Paid through: the end of the last paid month. plan stays 'trial' until the first payment.
-- The month in progress (and its minutes) is the paid va_payments row covering now.
alter table public.va_workspaces
  add column if not exists current_period_end timestamptz;

-- 3. Payments: one PayMongo Checkout Session each
create table if not exists public.va_payments (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  workspace_id uuid not null,
  plan_code text not null,
  -- 0 for a month granted by platform staff
  amount_cents int not null check (amount_cents >= 0),
  currency text not null default 'PHP',
  -- [{ name, amount_cents }]: the plan plus each phone number's monthly fee
  line_items jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  paymongo_checkout_id text unique,
  paymongo_payment_id text,
  checkout_url text,
  payment_method text,
  -- The month this payment bought (set when it's paid)
  period_start timestamptz,
  period_end timestamptz,
  paid_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, website_id) references public.va_workspaces (id, website_id) on delete cascade
);

create index if not exists va_payments_workspace_idx on public.va_payments (workspace_id, created_at desc);

alter table public.va_payments enable row level security;

drop policy if exists "Owners read va_payments" on public.va_payments;
create policy "Owners read va_payments" on public.va_payments
  for select to authenticated using (public.va_workspace_role(workspace_id) = 'owner');

-- 4. Talk time since a moment (the start of the paid month). Same rules as va_workspace_usage:
-- unfinished calls from the last 15 minutes count as 5 minutes.
create or replace function public.va_workspace_usage_since(p_website_id uuid, p_workspace_id uuid, p_since timestamptz)
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
  where l.website_id = p_website_id and l.workspace_id = p_workspace_id and l.created_at >= p_since
$$;

-- 5. Marks a payment paid and gives the workspace its month, once. A renewal of the same plan
-- starts when the current month ends; a new or different plan starts now.
create or replace function public.va_apply_payment(
  p_website_id uuid,
  p_payment_id uuid,
  p_paymongo_payment_id text,
  p_payment_method text
)
returns table (applied boolean, period_start timestamptz, period_end timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_payment public.va_payments;
  v_workspace public.va_workspaces;
  v_start timestamptz;
begin
  select * into v_payment from public.va_payments
  where id = p_payment_id and website_id = p_website_id
  for update;
  if not found or v_payment.status = 'paid' then
    return query select false, v_payment.period_start, v_payment.period_end;
    return;
  end if;

  select * into v_workspace from public.va_workspaces
  where id = v_payment.workspace_id and website_id = p_website_id
  for update;

  if v_workspace.plan = v_payment.plan_code
     and v_workspace.current_period_end is not null
     and v_workspace.current_period_end > now() then
    v_start := v_workspace.current_period_end;
  else
    v_start := now();
  end if;

  update public.va_payments
  set status = 'paid', paid_at = now(), paymongo_payment_id = p_paymongo_payment_id,
      payment_method = p_payment_method, period_start = v_start, period_end = v_start + interval '1 month'
  where id = p_payment_id;

  update public.va_workspaces
  set plan = v_payment.plan_code,
      -- A suspension by us stays in place; payment doesn't lift it
      status = case when status = 'suspended' then status else 'active' end,
      current_period_end = v_start + interval '1 month',
      updated_at = now()
  where id = v_workspace.id;

  return query select true, v_start, v_start + interval '1 month';
end;
$$;

revoke execute on function public.va_workspace_usage_since(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.va_apply_payment(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.va_workspace_usage_since(uuid, uuid, timestamptz) to service_role;
grant execute on function public.va_apply_payment(uuid, uuid, text, text) to service_role;
