'use client';

import { useState } from 'react';
import { Loader2, Phone, PhoneIncoming, PhoneOutgoing, Plus, Search, Trash2 } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { hasRole } from '@/lib/workspace-roles';
import type { NumberOffer, NumberProvider, PhoneNumber } from '@/lib/phone-numbers';

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';
const primaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60';
const secondaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50 disabled:opacity-60';

const PROVIDERS: Record<NumberProvider, string> = { retell: 'Bought via Retell', twilio: 'Bought via Twilio', byo: 'Your own SIP trunk' };
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  PH: 'Philippines',
  GB: 'United Kingdom',
  AU: 'Australia',
};

export function formatPhone(e164: string) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (us) return `+1 (${us[1]}) ${us[2]}-${us[3]}`;
  const ph = /^\+63(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (ph) return `+63 ${ph[1]} ${ph[2]} ${ph[3]}`;
  return e164;
}

function price(cents: number | null) {
  if (cents === null) return 'price unknown';
  return cents === 0 ? 'no monthly fee from us' : `$${(cents / 100).toFixed(2)}/month`;
}

function Toggle({
  label,
  icon: Icon,
  checked,
  busy,
  onChange,
}: {
  label: string;
  icon: typeof Phone;
  checked: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm text-slate-700 disabled:opacity-60"
    >
      <span className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <Icon className="h-4 w-4 text-slate-400" aria-hidden="true" />
      {label}
    </button>
  );
}

type AddMode = 'retell' | 'twilio' | 'byo';

export type PhoneNumbersProps = {
  initialNumbers: PhoneNumber[];
  callerId: string | null;
  /** Website admins can buy numbers until plans and billing exist. */
  canBuy: boolean;
  twilioEnabled: boolean;
  max: number;
  retellPriceCents: number;
  retellCountries: readonly string[];
  twilioCountries: readonly string[];
  callableCountries: readonly string[];
  sipUri: string;
};

export default function PhoneNumbers(props: PhoneNumbersProps) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const [numbers, setNumbers] = useState(props.initialNumbers);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const modes: { id: AddMode; label: string }[] = [
    ...(props.canBuy ? [{ id: 'retell' as const, label: 'Buy (US & Canada)' }] : []),
    ...(props.canBuy && props.twilioEnabled ? [{ id: 'twilio' as const, label: 'Buy (more countries)' }] : []),
    { id: 'byo', label: 'Bring your own' },
  ];
  const [mode, setMode] = useState<AddMode>(modes[0].id);
  const full = numbers.length >= props.max;

  async function send(path: string, method: string, body?: unknown) {
    const res = await fetch(`${api}/numbers${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
    return data;
  }

  async function toggle(n: PhoneNumber, patch: Partial<Pick<PhoneNumber, 'inbound_enabled' | 'outbound_enabled'>>) {
    setBusy(n.id);
    setError(null);
    try {
      const { number } = await send(`/${n.id}`, 'PATCH', patch);
      setNumbers((list) => list.map((x) => (x.id === n.id ? number : x)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function release(n: PhoneNumber) {
    setBusy(n.id);
    setError(null);
    try {
      await send(`/${n.id}`, 'DELETE');
      setNumbers((list) => list.filter((x) => x.id !== n.id));
      setReleasing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-sm font-medium text-slate-700">
          Your numbers <span className="font-normal text-slate-400">({numbers.length} of {props.max})</span>
        </h2>
        {numbers.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No phone number yet. Add one below so people can call your agent, and your agent can call them.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {numbers.map((n) => (
              <li key={n.id} className="space-y-3 py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
                    <Phone className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-900">
                      {formatPhone(n.e164)}
                      {n.e164 === props.callerId && (
                        <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">Caller ID</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {[n.nickname, PROVIDERS[n.provider], COUNTRY_NAMES[n.country] ?? n.country, price(n.monthly_price_cents)]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Can call: {n.outbound_countries.map((c) => COUNTRY_NAMES[c] ?? c).join(', ') || 'any country'}
                    </p>
                  </div>
                  {hasRole(role, 'owner') && releasing !== n.id && (
                    <button type="button" onClick={() => setReleasing(n.id)} className={secondaryBtn}>
                      <Trash2 className="h-4 w-4" /> Release
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-2 pl-12">
                  <Toggle
                    label="Answers incoming calls"
                    icon={PhoneIncoming}
                    checked={n.inbound_enabled}
                    busy={busy === n.id}
                    onChange={(v) => toggle(n, { inbound_enabled: v })}
                  />
                  <Toggle
                    label="Makes outbound calls"
                    icon={PhoneOutgoing}
                    checked={n.outbound_enabled}
                    busy={busy === n.id}
                    onChange={(v) => toggle(n, { outbound_enabled: v })}
                  />
                </div>

                {n.provider === 'byo' && n.inbound_enabled && (
                  <p className="ml-12 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    For incoming calls, set your SIP trunk’s origination (inbound) address to{' '}
                    <code className="font-mono text-slate-800">{props.sipUri}</code>.
                  </p>
                )}

                {releasing === n.id && (
                  <div className="ml-12 space-y-2 rounded-xl bg-red-50 p-3 text-sm text-red-800">
                    <p>
                      Release {formatPhone(n.e164)}? It stops answering calls right away
                      {n.provider === 'byo' ? '. Your number stays with your SIP provider.' : ', and we can’t get the same number back.'}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => release(n)}
                        disabled={busy === n.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-500 disabled:opacity-60"
                      >
                        {busy === n.id && <Loader2 className="h-4 w-4 animate-spin" />}
                        Release number
                      </button>
                      <button type="button" onClick={() => setReleasing(null)} className="rounded-lg px-3 py-1.5 font-medium text-red-700">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-sm font-medium text-slate-700">Add a number</h2>
        {!props.canBuy && (
          <p className="mt-1 text-sm text-slate-500">
            Buying a number from us comes with paid plans. Until then, contact us to add one, or connect a number you already have.
          </p>
        )}
        {full ? (
          <p className="mt-3 text-sm text-slate-500">Your plan includes {props.max} {props.max === 1 ? 'number' : 'numbers'}. Release one or upgrade under Billing to add another.</p>
        ) : (
          <>
            {modes.length > 1 && (
              <div role="tablist" className="mt-3 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5 text-sm font-medium sm:w-fit">
                {modes.map((m) => (
                  <button
                    key={m.id}
                    role="tab"
                    aria-selected={mode === m.id}
                    onClick={() => setMode(m.id)}
                    className={`rounded-md px-3 py-1.5 transition ${mode === m.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4">
              {mode === 'retell' && (
                <BuyRetell {...props} onAdded={(n) => setNumbers((list) => [...list, n])} send={send} />
              )}
              {mode === 'twilio' && (
                <BuyTwilio {...props} onAdded={(n) => setNumbers((list) => [...list, n])} send={send} />
              )}
              {mode === 'byo' && <BringYourOwn {...props} onAdded={(n) => setNumbers((list) => [...list, n])} send={send} />}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

type AddProps = PhoneNumbersProps & {
  onAdded: (n: PhoneNumber) => void;
  send: (path: string, method: string, body?: unknown) => Promise<Record<string, unknown>>;
};

/** Shared confirm step: buying starts a monthly charge, so it always takes a second click. */
function ConfirmPurchase({
  summary,
  busy,
  onConfirm,
  onCancel,
}: {
  summary: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
      <p>{summary} It’s billed every month until you release it.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className={primaryBtn}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Confirm purchase
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg px-3 py-2 font-medium text-amber-900">
          Cancel
        </button>
      </div>
    </div>
  );
}

function BuyRetell({ retellCountries, retellPriceCents, onAdded, send }: AddProps) {
  const [country, setCountry] = useState(retellCountries[0]);
  const [areaCode, setAreaCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const { number } = await send('', 'POST', { provider: 'retell', country, area_code: areaCode, nickname });
      onAdded(number as PhoneNumber);
      setConfirming(false);
      setAreaCode('');
      setNickname('');
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium text-slate-700">
          Country
          <select className={inputCls} value={country} onChange={(e) => setCountry(e.target.value)}>
            {retellCountries.map((c) => (
              <option key={c} value={c}>
                {COUNTRY_NAMES[c] ?? c}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Area code <span className="font-normal text-slate-400">optional</span>
          <input
            className={inputCls}
            inputMode="numeric"
            maxLength={3}
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))}
            placeholder="415"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Nickname <span className="font-normal text-slate-400">optional</span>
          <input className={inputCls} maxLength={60} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Front desk" />
        </label>
      </div>
      <p className="text-xs text-slate-500">
        Retell picks an available number{areaCode ? ` in area code ${areaCode}` : ''}. {`$${(retellPriceCents / 100).toFixed(2)}`}/month. These
        numbers can call the US and Canada.
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {confirming ? (
        <ConfirmPurchase
          summary={`Buy a ${COUNTRY_NAMES[country] ?? country} number${areaCode ? ` in area code ${areaCode}` : ''} for $${(retellPriceCents / 100).toFixed(2)}/month?`}
          busy={busy}
          onConfirm={buy}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={areaCode.length > 0 && areaCode.length < 3}
          className={primaryBtn}
        >
          <Plus className="h-4 w-4" /> Buy a number…
        </button>
      )}
    </div>
  );
}

function BuyTwilio({ twilioCountries, onAdded, send }: AddProps) {
  const [country, setCountry] = useState(twilioCountries[0]);
  const [areaCode, setAreaCode] = useState('');
  const [offers, setOffers] = useState<NumberOffer[] | null>(null);
  const [chosen, setChosen] = useState<NumberOffer | null>(null);
  const [nickname, setNickname] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setChosen(null);
    try {
      const query = new URLSearchParams({ country, ...(areaCode && { area_code: areaCode }) });
      const { offers } = await send(`/search?${query}`, 'GET');
      setOffers(offers as NumberOffer[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function buy() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const { number } = await send('', 'POST', { provider: 'twilio', e164: chosen.e164, country, nickname });
      onAdded(number as PhoneNumber);
      setOffers(null);
      setChosen(null);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={search} className="flex flex-wrap items-end gap-3">
        <label className="block text-sm font-medium text-slate-700">
          Country
          <select
            className={inputCls}
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              setOffers(null);
            }}
          >
            {twilioCountries.map((c) => (
              <option key={c} value={c}>
                {COUNTRY_NAMES[c] ?? c}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Area code <span className="font-normal text-slate-400">optional</span>
          <input
            className={inputCls}
            inputMode="numeric"
            maxLength={5}
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button type="submit" disabled={busy} className={secondaryBtn}>
          {busy && !confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
        </button>
      </form>
      <p className="text-xs text-slate-500">
        Numbers from our Twilio account, connected over our SIP trunk. They can call the Philippines, the US and Canada. Some
        countries need ID documents before Twilio sells a number.
      </p>

      {offers && offers.length === 0 && <p className="text-sm text-slate-500">No numbers found. Try another area code.</p>}
      {offers && offers.length > 0 && (
        <ul className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2" aria-label="Available numbers">
          {offers.map((o) => (
            <li key={o.e164}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg p-3 text-sm ring-1 transition ${chosen?.e164 === o.e164 ? 'bg-indigo-50 ring-indigo-300' : 'ring-slate-200 hover:bg-slate-50'}`}
              >
                <input type="radio" name="offer" checked={chosen?.e164 === o.e164} onChange={() => setChosen(o)} className="text-indigo-600" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-900">{formatPhone(o.e164)}</span>
                  <span className="block text-xs text-slate-500">
                    {[o.locality, o.region, o.type === 'mobile' ? 'mobile' : null].filter(Boolean).join(', ') || 'Location not listed'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-slate-600">{price(o.monthly_price_cents)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {chosen && (
        <label className="block max-w-sm text-sm font-medium text-slate-700">
          Nickname <span className="font-normal text-slate-400">optional</span>
          <input className={inputCls} maxLength={60} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Front desk" />
        </label>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {chosen &&
        (confirming ? (
          <ConfirmPurchase
            summary={`Buy ${formatPhone(chosen.e164)} for ${price(chosen.monthly_price_cents)}?`}
            busy={busy}
            onConfirm={buy}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={primaryBtn}>
            <Plus className="h-4 w-4" /> Buy {formatPhone(chosen.e164)}…
          </button>
        ))}
    </div>
  );
}

function BringYourOwn({ callableCountries, sipUri, onAdded, send }: AddProps) {
  const [form, setForm] = useState({ e164: '', termination_uri: '', username: '', password: '', nickname: '' });
  const [countries, setCountries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { number } = await send('', 'POST', { provider: 'byo', ...form, outbound_countries: countries });
      onAdded(number as PhoneNumber);
      setForm({ e164: '', termination_uri: '', username: '', password: '', nickname: '' });
      setCountries([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-slate-600">
        Connect a number you already have with a SIP trunk provider (Twilio, Telnyx, Plivo and others). Calls are carried by your provider,
        so there’s no monthly fee from us.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Phone number
          <input className={inputCls} required value={form.e164} onChange={set('e164')} placeholder="+639171234567" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Nickname <span className="font-normal text-slate-400">optional</span>
          <input className={inputCls} maxLength={60} value={form.nickname} onChange={set('nickname')} placeholder="Main line" />
        </label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
          Termination address (for outbound calls)
          <input className={inputCls} required value={form.termination_uri} onChange={set('termination_uri')} placeholder="mytrunk.pstn.twilio.com" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          SIP username <span className="font-normal text-slate-400">if your trunk uses one</span>
          <input className={inputCls} autoComplete="off" value={form.username} onChange={set('username')} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          SIP password
          <input className={inputCls} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </label>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Countries it may call</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          {callableCountries.map((c) => (
            <label key={c} className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={countries.includes(c)}
                onChange={(e) => setCountries((list) => (e.target.checked ? [...list, c] : list.filter((x) => x !== c)))}
                className="rounded text-indigo-600"
              />
              {COUNTRY_NAMES[c] ?? c}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-400">None checked: only the number’s own country.</p>
      </fieldset>
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        For incoming calls, set your trunk’s origination (inbound) address to <code className="font-mono text-slate-800">{sipUri}</code>.
        Your SIP password goes straight to our voice provider and isn’t stored by Voice Agent. To change it, release the number and connect it
        again.
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={primaryBtn}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Connect number
      </button>
    </form>
  );
}
