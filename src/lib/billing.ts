import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import * as paymongo from '@/lib/paymongo';
import { toPhpCents, usdToPhp } from '@/lib/fx';
import { getWorkspaceUsageSeconds, type Workspace } from '@/lib/workspaces';

// Phase 6: prepaid monthly plans. Prices are in USD; PayMongo Checkout charges the peso amount
// at the day's rate (GCash, Maya and cards all take pesos). A workspace pays one month at a
// time; calls stop when the month's minutes run out or the month ends. Nothing renews on its
// own: owners get reminders and pay again.

export type Plan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: 'USD';
  included_minutes: number;
  overage_cents_per_minute: number | null;
  max_widgets: number;
  max_numbers: number;
  max_documents: number;
  max_faqs: number;
  max_pages: number;
  outbound_allowed: boolean;
  ai_suggestions: boolean;
  active: boolean;
  sort: number;
};

export type Limits = Pick<Plan, 'max_widgets' | 'max_numbers' | 'max_documents' | 'max_faqs' | 'max_pages' | 'outbound_allowed'>;
export type LimitKind = 'widgets' | 'numbers' | 'documents' | 'faqs' | 'pages';

export type BillingState = 'platform' | 'trial' | 'active' | 'expired' | 'suspended';

export type Billing = {
  state: BillingState;
  /** The plan being paid for (null on trial and the platform workspace). */
  plan: Plan | null;
  limits: Limits;
  /** The paid month in progress. */
  period: { start: string; end: string } | null;
  /** End of the last paid month (later than period.end when a renewal is already paid). */
  paidThrough: string | null;
  /** Talk time this month (or for the whole trial). Null when unlimited. */
  minutes: { includedSeconds: number; usedSeconds: number } | null;
  /** The month ends within RENEWAL_REMINDER_DAYS and the next one isn't paid. */
  renewalDue: boolean;
};

export class BillingError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export class CallBlockedError extends Error {
  constructor(
    message: string,
    public reason: 'suspended' | 'trial_used' | 'minutes_used' | 'expired'
  ) {
    super(message);
  }
}

const TRIAL_LIMITS: Limits = {
  max_widgets: 1,
  max_numbers: 1,
  max_documents: 5,
  max_faqs: 20,
  max_pages: 3,
  outbound_allowed: false,
};
const UNLIMITED: Limits = {
  max_widgets: 50,
  max_numbers: 20,
  max_documents: 500,
  max_faqs: 200,
  max_pages: 25,
  outbound_allowed: true,
};
const LIMIT_LABELS: Record<LimitKind, [string, string, keyof Limits]> = {
  widgets: ['widget', 'widgets', 'max_widgets'],
  numbers: ['phone number', 'phone numbers', 'max_numbers'],
  documents: ['document', 'documents', 'max_documents'],
  faqs: ['FAQ entry', 'FAQ entries', 'max_faqs'],
  pages: ['web page', 'web pages', 'max_pages'],
};

/** What we charge per month (US cents) for a number we bought (it costs us ~$2). Customers' own numbers are free. */
export const NUMBER_FEE_CENTS = 300;
/** Shortest call we start: Retell can't cap a call under 1 minute. */
const MIN_CALL_SECONDS = 60;
/** Owners are reminded this long before the paid month ends. */
export const RENEWAL_REMINDER_DAYS = 5;
/** Checkout sessions older than this are no longer checked with PayMongo. */
const CHECKOUT_TTL_MS = 2 * 24 * 60 * 60 * 1000;

function db() {
  return createAdminClient();
}

export async function listPlans(): Promise<Plan[]> {
  const { data, error } = await db()
    .from('va_plans')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('active', true)
    .order('sort', { ascending: true });
  if (error) throw new Error(`Failed to load plans: ${error.message}`);
  return data as Plan[];
}

async function getPlan(code: string): Promise<Plan | null> {
  const { data, error } = await db().from('va_plans').select('*').eq('website_id', WEBSITE_ID).eq('code', code).maybeSingle();
  if (error) throw new Error(`Failed to load plan: ${error.message}`);
  return (data as Plan) ?? null;
}

/** The paid month covering now (the newest, when a plan change overlaps an older month). */
async function currentPeriod(workspaceId: string): Promise<{ start: string; end: string; plan_code: string } | null> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('va_payments')
    .select('period_start, period_end, plan_code')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('status', 'paid')
    .lte('period_start', now)
    .gt('period_end', now)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the billing period: ${error.message}`);
  return data ? { start: data.period_start, end: data.period_end, plan_code: data.plan_code } : null;
}

async function usageSince(workspaceId: string, since: string): Promise<number> {
  const { data, error } = await db().rpc('va_workspace_usage_since', {
    p_website_id: WEBSITE_ID,
    p_workspace_id: workspaceId,
    p_since: since,
  });
  if (error) throw new Error(`Failed to load usage: ${error.message}`);
  return Number(data ?? 0);
}

/** Where a workspace stands: plan, limits, this month's minutes. */
export async function getBilling(workspace: Workspace): Promise<Billing> {
  if (workspace.is_platform) {
    return { state: 'platform', plan: null, limits: UNLIMITED, period: null, paidThrough: null, minutes: null, renewalDue: false };
  }
  if (workspace.status === 'trial') {
    return {
      state: 'trial',
      plan: null,
      limits: TRIAL_LIMITS,
      period: null,
      paidThrough: null,
      minutes: { includedSeconds: workspace.trial_seconds, usedSeconds: await getWorkspaceUsageSeconds(workspace.id) },
      renewalDue: false,
    };
  }

  const period = await currentPeriod(workspace.id);
  const plan = await getPlan(period?.plan_code ?? workspace.plan);
  const limits = plan ?? TRIAL_LIMITS;
  const paidThrough = workspace.current_period_end;
  const state: BillingState = workspace.status === 'suspended' ? 'suspended' : period ? 'active' : 'expired';
  return {
    state,
    plan,
    limits,
    period: period && { start: period.start, end: period.end },
    paidThrough,
    minutes:
      period && plan ? { includedSeconds: plan.included_minutes * 60, usedSeconds: await usageSince(workspace.id, period.start) } : null,
    renewalDue:
      period !== null &&
      paidThrough === period.end &&
      new Date(period.end).getTime() - Date.now() <= RENEWAL_REMINDER_DAYS * 24 * 60 * 60 * 1000,
  };
}

/**
 * Checks a workspace may start a call. Returns the call's cap in ms (the minutes left this
 * month or in the trial), or undefined when there's no cap (the platform workspace).
 */
export async function callLimitMs(workspace: Workspace): Promise<number | undefined> {
  if (workspace.status === 'suspended') throw new CallBlockedError('This workspace is suspended.', 'suspended');
  const billing = await getBilling(workspace);
  if (billing.state === 'platform') return undefined;
  if (billing.state === 'expired') throw new CallBlockedError('This workspace’s paid month has ended.', 'expired');
  const left = billing.minutes!.includedSeconds - billing.minutes!.usedSeconds;
  if (left < MIN_CALL_SECONDS) {
    throw billing.state === 'trial'
      ? new CallBlockedError('This workspace has used its free trial minutes.', 'trial_used')
      : new CallBlockedError('This workspace has used this month’s minutes.', 'minutes_used');
  }
  return left * 1000;
}

/** What a workspace admin sees when a call is blocked. */
export function callBlockedMessage(error: CallBlockedError) {
  switch (error.reason) {
    case 'suspended':
      return 'This workspace is suspended. Contact us to turn calls back on.';
    case 'trial_used':
      return 'Your free trial minutes are used up. Choose a plan under Billing to keep taking calls.';
    case 'minutes_used':
      return 'This month’s minutes are used up. Upgrade under Billing to keep taking calls.';
    case 'expired':
      return 'Your paid month has ended. Renew under Billing to turn calls back on.';
  }
}

/** Throws when adding one more item would go over the plan. `count` is how many there are now. */
export async function assertWithinLimit(workspace: Workspace, kind: LimitKind, count: number): Promise<void> {
  const { limits, plan, state } = await getBilling(workspace);
  const [one, many, key] = LIMIT_LABELS[kind];
  const max = limits[key] as number;
  if (count < max) return;
  const owner = state === 'trial' ? 'The free trial' : plan ? `The ${plan.name} plan` : 'This workspace';
  throw new BillingError(`${owner} includes ${max} ${max === 1 ? one : many}. Upgrade under Billing to add more.`, 403);
}

export async function assertOutboundAllowed(workspace: Workspace): Promise<void> {
  const { limits, state } = await getBilling(workspace);
  if (!limits.outbound_allowed) {
    throw new BillingError(
      state === 'trial' ? 'Outbound calls come with the Growth and Business plans.' : 'Your plan doesn’t include outbound calls. Upgrade under Billing.',
      403
    );
  }
}

// ---------------------------------------------------------------------------
// Payments

export type Payment = {
  id: string;
  plan_code: string;
  /** Price in `currency` (USD; PHP for payments made before USD pricing). */
  amount_cents: number;
  currency: string;
  /** What PayMongo charged, in pesos, at `exchange_rate`. */
  charged_amount_cents: number | null;
  exchange_rate: number | null;
  line_items: { name: string; amount_cents: number }[];
  status: 'pending' | 'paid' | 'expired';
  checkout_url: string | null;
  payment_method: string | null;
  period_start: string | null;
  period_end: string | null;
  paid_at: string | null;
  created_at: string;
};

const PAYMENT_COLUMNS =
  'id, plan_code, amount_cents, currency, charged_amount_cents, exchange_rate, line_items, status, checkout_url, payment_method, period_start, period_end, paid_at, created_at';

/** The plan plus a fee for each number we bought for the workspace, in US cents. */
export async function lineItemsFor(workspace: Workspace, plan: Plan): Promise<{ name: string; amount_cents: number }[]> {
  const { data, error } = await db()
    .from('va_phone_numbers')
    .select('e164, provider')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('status', 'active')
    .neq('provider', 'byo');
  if (error) throw new Error(`Failed to load phone numbers: ${error.message}`);
  return [
    { name: `${plan.name} plan · 1 month · ${plan.included_minutes} minutes`, amount_cents: plan.price_cents },
    ...data.map((n) => ({ name: `Phone number ${n.e164} · 1 month`, amount_cents: NUMBER_FEE_CENTS })),
  ];
}

/** Starts a PayMongo checkout for one month of a plan. Returns the page to send the owner to. */
export async function startCheckout(workspace: Workspace, userId: string, planCode: string, appUrl: string): Promise<string> {
  if (workspace.is_platform) throw new BillingError('The platform workspace isn’t billed', 400);
  if (workspace.status === 'suspended') throw new BillingError('This workspace is suspended. Contact us first.', 403);
  const plan = await getPlan(planCode);
  if (!plan?.active) throw new BillingError('Choose one of the plans', 400);
  const lineItems = await lineItemsFor(workspace, plan);
  const amount = lineItems.reduce((sum, item) => sum + item.amount_cents, 0);
  // PayMongo charges pesos: each item at today's rate, rounded to the peso
  const rate = await usdToPhp();
  const phpItems = lineItems.map((item) => ({ name: item.name, amount_cents: toPhpCents(item.amount_cents, rate) }));
  const charged = phpItems.reduce((sum, item) => sum + item.amount_cents, 0);

  const { data: payment, error } = await db()
    .from('va_payments')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      plan_code: plan.code,
      amount_cents: amount,
      currency: 'USD',
      charged_currency: 'PHP',
      charged_amount_cents: charged,
      exchange_rate: rate,
      line_items: lineItems,
      created_by: userId,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to start the payment: ${error.message}`);

  const billingUrl = `${appUrl}/w/${workspace.slug}/billing`;
  try {
    const checkout = await paymongo.createCheckout({
      lineItems: phpItems,
      description: `${workspace.name}: ${plan.name} plan, 1 month ($${(amount / 100).toFixed(2)} at ₱${rate.toFixed(2)}/$)`,
      reference: payment.id,
      successUrl: `${billingUrl}?payment=${payment.id}`,
      cancelUrl: billingUrl,
      metadata: { website_id: WEBSITE_ID, workspace_id: workspace.id, payment_id: payment.id },
    });
    await db()
      .from('va_payments')
      .update({ paymongo_checkout_id: checkout.id, checkout_url: checkout.url })
      .eq('id', payment.id);
    return checkout.url;
  } catch (err) {
    await db().from('va_payments').delete().eq('id', payment.id);
    throw err;
  }
}

/** Platform staff: give a workspace one month of a plan without payment (e.g. paid by bank transfer). */
export async function grantMonth(workspace: Workspace, planCode: string, staffUserId: string): Promise<void> {
  if (workspace.is_platform) throw new BillingError('The platform workspace isn’t billed', 400);
  const plan = await getPlan(planCode);
  if (!plan) throw new BillingError('Unknown plan', 400);
  const { data: payment, error } = await db()
    .from('va_payments')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      plan_code: plan.code,
      amount_cents: 0,
      currency: 'USD',
      charged_amount_cents: 0,
      line_items: [{ name: `${plan.name} plan · 1 month (granted by Voice Agent)`, amount_cents: 0 }],
      created_by: staffUserId,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to grant the month: ${error.message}`);
  const { error: applyError } = await db().rpc('va_apply_payment', {
    p_website_id: WEBSITE_ID,
    p_payment_id: payment.id,
    p_paymongo_payment_id: null,
    p_payment_method: 'granted',
  });
  if (applyError) throw new Error(`Failed to grant the month: ${applyError.message}`);
}

/** Asks PayMongo about one pending payment and applies it if it's paid. Returns its new status. */
async function settle(payment: { id: string; paymongo_checkout_id: string | null; created_at: string }): Promise<Payment['status']> {
  if (!payment.paymongo_checkout_id) return 'pending';
  const checkout = await paymongo.getCheckout(payment.paymongo_checkout_id);
  if (checkout.paidPaymentId) {
    const { error } = await db().rpc('va_apply_payment', {
      p_website_id: WEBSITE_ID,
      p_payment_id: payment.id,
      p_paymongo_payment_id: checkout.paidPaymentId,
      p_payment_method: checkout.method,
    });
    if (error) throw new Error(`Paid, but the plan wasn’t applied: ${error.message}`);
    return 'paid';
  }
  if (checkout.status === 'expired' || Date.now() - new Date(payment.created_at).getTime() > CHECKOUT_TTL_MS) {
    await db().from('va_payments').update({ status: 'expired' }).eq('id', payment.id).eq('status', 'pending');
    return 'expired';
  }
  return 'pending';
}

/**
 * Applies any of the workspace's recent payments PayMongo says are paid. The webhook does this
 * too; this covers local dev and a webhook that hasn't arrived yet.
 */
export async function reconcilePayments(workspace: Workspace): Promise<void> {
  const { data, error } = await db()
    .from('va_payments')
    .select('id, paymongo_checkout_id, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('status', 'pending');
  if (error) throw new Error(`Failed to load payments: ${error.message}`);
  for (const payment of data) {
    await settle(payment).catch((err) => console.error('[billing] failed to check payment', payment.id, err));
  }
}

/** Webhook: a checkout was paid. The session is re-read from PayMongo rather than trusted. */
export async function settleCheckout(checkoutId: string): Promise<boolean> {
  const { data, error } = await db()
    .from('va_payments')
    .select('id, paymongo_checkout_id, created_at, status')
    .eq('website_id', WEBSITE_ID)
    .eq('paymongo_checkout_id', checkoutId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load payment: ${error.message}`);
  if (!data) return false;
  if (data.status === 'paid') return true;
  return (await settle(data)) === 'paid';
}

export async function listPayments(workspace: Workspace, limit = 24): Promise<Payment[]> {
  const { data, error } = await db()
    .from('va_payments')
    .select(PAYMENT_COLUMNS)
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load payments: ${error.message}`);
  return data as Payment[];
}

// ---------------------------------------------------------------------------
// Platform revenue view

export type RevenueRow = {
  workspace_id: string;
  name: string;
  slug: string;
  state: string;
  plan: string;
  /** US cents. */
  revenue_cents: number;
  /** Retell call cost plus our numbers' monthly price, in US cents. */
  cost_cents: number;
  margin_cents: number;
};

/** Revenue against cost per workspace over the last `days` days, plus monthly recurring revenue, in USD. */
export async function getRevenueReport(days: number): Promise<{ mrr_cents: number; rows: RevenueRow[] }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const [workspaces, payments, calls, numbers, plans] = await Promise.all([
    db().from('va_workspaces').select('id, name, slug, status, plan, is_platform, current_period_end').eq('website_id', WEBSITE_ID),
    db()
      .from('va_payments')
      .select('workspace_id, amount_cents, currency, exchange_rate, paid_at, period_start, period_end')
      .eq('website_id', WEBSITE_ID)
      .eq('status', 'paid'),
    db().from('va_call_logs').select('workspace_id, cost_cents').eq('website_id', WEBSITE_ID).gte('created_at', since).not('cost_cents', 'is', null).limit(50000),
    db().from('va_phone_numbers').select('workspace_id, monthly_price_cents').eq('website_id', WEBSITE_ID).eq('status', 'active'),
    db().from('va_plans').select('code, name').eq('website_id', WEBSITE_ID),
  ]);
  for (const r of [workspaces, payments, calls, numbers, plans]) {
    if (r.error) throw new Error(`Failed to load the revenue report: ${r.error.message}`);
  }
  const planNames = new Map((plans.data ?? []).map((p) => [p.code, p.name]));
  // Payments from before USD pricing were in pesos
  const rate = await usdToPhp();
  const usd = (p: { amount_cents: number; currency: string; exchange_rate: number | null }) =>
    p.currency === 'USD' ? p.amount_cents : Math.round(p.amount_cents / (Number(p.exchange_rate) || rate));
  const sum = <T,>(rows: T[], key: (r: T) => number) => rows.reduce((total, r) => total + key(r), 0);

  let mrr = 0;
  const rows = (workspaces.data ?? [])
    .filter((w) => !w.is_platform)
    .map((w) => {
      const paid = (payments.data ?? []).filter((p) => p.workspace_id === w.id);
      const revenue = sum(paid.filter((p) => p.paid_at >= since), usd);
      // MRR: what the month in progress was paid
      const current = paid.filter((p) => p.period_start <= now && p.period_end > now).sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
      if (current && w.status !== 'suspended') mrr += usd(current);
      const callCostUsdCents = sum((calls.data ?? []).filter((c) => c.workspace_id === w.id), (c) => Number(c.cost_cents));
      const numberCostUsdCents = sum((numbers.data ?? []).filter((n) => n.workspace_id === w.id), (n) => n.monthly_price_cents ?? 0) * (days / 30);
      const cost = Math.round(callCostUsdCents + numberCostUsdCents);
      const state = w.status === 'suspended' ? 'suspended' : w.status === 'trial' ? 'trial' : current ? 'active' : 'expired';
      return {
        workspace_id: w.id,
        name: w.name,
        slug: w.slug,
        state,
        plan: w.status === 'trial' ? 'Trial' : (planNames.get(w.plan) ?? w.plan),
        revenue_cents: revenue,
        cost_cents: cost,
        margin_cents: revenue - cost,
      };
    })
    .sort((a, b) => a.margin_cents - b.margin_cents);
  return { mrr_cents: mrr, rows };
}
