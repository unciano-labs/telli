'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CheckCircle2, Clock, Loader2, Minus, XCircle } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import type { Billing, Payment, Plan } from '@/lib/billing';
import { formatPhp, formatUsd } from '@/lib/money';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const STATE_LABELS: Record<Billing['state'], { label: string; cls: string }> = {
  platform: { label: 'Platform', cls: 'bg-violet-50 text-violet-700' },
  trial: { label: 'Free trial', cls: 'bg-amber-50 text-amber-800' },
  active: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700' },
  expired: { label: 'Paid month ended', cls: 'bg-red-50 text-red-700' },
  suspended: { label: 'Suspended', cls: 'bg-red-50 text-red-700' },
};

const PAYMENT_STATUS: Record<Payment['status'], { label: string; icon: typeof Check; cls: string }> = {
  paid: { label: 'Paid', icon: CheckCircle2, cls: 'text-emerald-700' },
  pending: { label: 'Not paid yet', icon: Clock, cls: 'text-amber-700' },
  expired: { label: 'Expired', icon: XCircle, cls: 'text-slate-400' },
};

function Feature({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-start gap-2 ${ok ? 'text-slate-700' : 'text-slate-400'}`}>
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <Minus className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{children}</span>
    </li>
  );
}

/** Minutes used this month: a labelled meter, value in text ink, never colour alone. */
function MinutesMeter({ used, included }: { used: number; included: number }) {
  const share = included ? Math.min(used / included, 1) : 1;
  const tone = share >= 1 ? 'bg-red-500' : share >= 0.8 ? 'bg-amber-500' : 'bg-indigo-500';
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-slate-600">Minutes used</span>
        <span className="font-medium text-slate-900">
          {Math.floor(used / 60)} of {Math.round(included / 60)}
          <span className="ml-1 text-xs font-normal text-slate-400">({Math.round(share * 100)}%)</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-2 rounded-full bg-slate-100"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={Math.round(included / 60)}
        aria-valuenow={Math.floor(used / 60)}
        aria-label="Minutes used"
      >
        <div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.max(share * 100, used > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

export default function BillingView({
  billing,
  plans,
  payments,
  numberFeeCents,
  paidNumbers,
  testMode,
  phpRate,
  showPhp,
  returnedPayment,
}: {
  billing: Billing;
  plans: Plan[];
  payments: Payment[];
  numberFeeCents: number;
  /** Numbers we provide, billed monthly with the plan. */
  paidNumbers: number;
  testMode: boolean;
  /** Today's pesos per dollar: PayMongo charges in pesos. */
  phpRate: number;
  /** The visitor is in the Philippines: show peso amounts next to dollar prices. */
  showPhp: boolean;
  /** The payment the owner just came back from PayMongo for, if any. */
  returnedPayment: Payment | null;
}) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = STATE_LABELS[billing.state];
  const inPesos = (usdCents: number) => formatPhp(Math.round((usdCents * phpRate) / 100) * 100);
  const current = billing.state === 'active' || billing.state === 'expired' ? billing.plan : null;

  // PayMongo can take a few seconds to confirm after the owner returns
  const waiting = returnedPayment?.status === 'pending';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), 4000);
    const stop = setTimeout(() => clearInterval(timer), 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [waiting, router]);

  async function checkout(plan: Plan) {
    setBusy(plan.code);
    setError(null);
    try {
      const res = await fetch(`${api}/billing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Couldn’t start the payment');
      window.location.assign(data.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  function buttonFor(plan: Plan) {
    const isCurrent = current?.code === plan.code;
    const label = isCurrent ? (billing.state === 'active' ? 'Pay for next month' : 'Renew') : `Choose ${plan.name}`;
    // Switching plans mid-month starts the new plan today
    const switching = billing.state === 'active' && !isCurrent;
    if (confirm === plan.code) {
      return (
        <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">
          <p>{plan.name} starts today and replaces the rest of your current month. Minutes left this month don’t carry over.</p>
          <div className="flex gap-2">
            <button onClick={() => checkout(plan)} disabled={busy !== null} className="rounded-md bg-indigo-600 px-2.5 py-1.5 font-medium text-white">
              {busy === plan.code ? 'Opening PayMongo…' : 'Continue to payment'}
            </button>
            <button onClick={() => setConfirm(null)} className="px-2 font-medium">
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <button
        onClick={() => (switching ? setConfirm(plan.code) : checkout(plan))}
        disabled={busy !== null}
        className={`inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-60 ${isCurrent ? 'bg-white text-indigo-700 ring-1 ring-indigo-300 hover:bg-indigo-50' : 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500'}`}
      >
        {busy === plan.code && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-6">
      {returnedPayment?.status === 'paid' && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Payment received. Thank you! {returnedPayment.period_end && `Your plan runs until ${day(returnedPayment.period_end)}.`}
        </p>
      )}
      {waiting && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-slate-200">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> Waiting for PayMongo to confirm your payment…
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-slate-900">{current ? `${current.name} plan` : billing.state === 'platform' ? 'Platform workspace' : 'Free trial'}</h2>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
        </div>
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <div className="space-y-1 text-sm text-slate-600">
            {billing.state === 'platform' && <p>This workspace runs the site’s own agent and isn’t billed.</p>}
            {billing.state === 'trial' && <p>Try the agent for free. Choose a plan when you’re ready to take real calls.</p>}
            {billing.period && (
              <p>
                This month: {day(billing.period.start)} – {day(billing.period.end)}
              </p>
            )}
            {billing.paidThrough && billing.period && billing.paidThrough > billing.period.end && <p>Next month is paid: through {day(billing.paidThrough)}.</p>}
            {billing.state === 'expired' && billing.paidThrough && (
              <p className="text-red-700">Your paid month ended on {day(billing.paidThrough)}, so calls are paused. Renew to turn them back on.</p>
            )}
            {paidNumbers > 0 && (
              <p>
                {paidNumbers} phone {paidNumbers === 1 ? 'number' : 'numbers'} from us: {formatUsd(numberFeeCents)}/month each{showPhp && ` (≈ ${inPesos(numberFeeCents)})`}, added to each payment.
              </p>
            )}
            <p className="text-xs text-slate-400">Plans are paid one month at a time and never renew on their own.</p>
          </div>
          {billing.minutes && <MinutesMeter used={billing.minutes.usedSeconds} included={billing.minutes.includedSeconds} />}
        </div>
      </section>

      {billing.state !== 'platform' && (
        <section aria-labelledby="plans-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="plans-heading" className="text-base font-semibold text-slate-900">
              Plans
            </h2>
            <p className="text-xs text-slate-500">
              Prices in US dollars. You pay the peso amount at today’s rate (₱{phpRate.toFixed(2)} = $1) with GCash, Maya, GrabPay,
              QR Ph or card through PayMongo.
              {testMode && <span className="ml-1 font-medium text-amber-700">Test mode: no real money is charged.</span>}
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.code}
                className={`flex flex-col rounded-2xl bg-white p-5 shadow-sm ring-1 ${current?.code === plan.code ? 'ring-2 ring-indigo-500' : 'ring-slate-200'}`}
              >
                <h3 className="font-semibold text-slate-900">{plan.name}</h3>
                {plan.description && <p className="mt-1 text-sm text-slate-500">{plan.description}</p>}
                <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                  {formatUsd(plan.price_cents)}
                  <span className="text-sm font-normal text-slate-500">/month</span>
                </p>
                {showPhp && <p className="text-xs text-slate-400">≈ {inPesos(plan.price_cents)} at today’s rate</p>}
                <ul className="mt-4 flex-1 space-y-1.5 text-sm">
                  <Feature ok>{plan.included_minutes} call minutes a month</Feature>
                  <Feature ok>
                    {plan.max_widgets} website {plan.max_widgets === 1 ? 'widget' : 'widgets'}
                  </Feature>
                  <Feature ok>
                    Up to {plan.max_numbers} phone {plan.max_numbers === 1 ? 'number' : 'numbers'}
                  </Feature>
                  <Feature ok>
                    {plan.max_faqs} FAQs, {plan.max_documents} documents, {plan.max_pages} web pages
                  </Feature>
                  <Feature ok={plan.outbound_allowed}>Outbound calls</Feature>
                </ul>
                <div className="mt-5">{buttonFor(plan)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {payments.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-sm font-medium text-slate-700">Payments</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">For</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payments.map((p) => {
                  const st = PAYMENT_STATUS[p.status];
                  return (
                    <tr key={p.id} className="align-top">
                      <td className="whitespace-nowrap py-2 pr-4 text-slate-600">{day(p.paid_at ?? p.created_at)}</td>
                      <td className="py-2 pr-4 text-slate-700">
                        {p.line_items.map((item) => (
                          <div key={item.name}>{item.name}</div>
                        ))}
                        {p.period_start && p.period_end && (
                          <div className="text-xs text-slate-400">
                            {day(p.period_start)} – {day(p.period_end)}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 text-right font-medium text-slate-900">
                        {p.currency === 'USD' ? formatUsd(p.amount_cents) : formatPhp(p.amount_cents)}
                        {p.currency === 'USD' && p.charged_amount_cents ? (
                          <div className="text-xs font-normal text-slate-400">charged {formatPhp(p.charged_amount_cents)}</div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap py-2">
                        <span className={`inline-flex items-center gap-1 ${st.cls}`}>
                          <st.icon className="h-4 w-4" /> {st.label}
                          {p.payment_method && p.status === 'paid' && <span className="text-xs text-slate-400">· {p.payment_method}</span>}
                        </span>
                        {p.status === 'pending' && p.checkout_url && (
                          <a href={p.checkout_url} className="ml-2 text-xs font-medium text-indigo-600 hover:underline">
                            Pay now
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
