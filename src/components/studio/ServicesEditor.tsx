'use client';

import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { formatPrice } from '@/lib/money';
import { CURRENCIES, WEEKDAY_LABELS, WEEKDAYS, type ReservationSettings, type Weekday } from '@/lib/modules-shared';
import type { Service } from '@/lib/bookings';

export const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600 disabled:bg-slate-50';
export const primaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60';
export const secondaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50 disabled:opacity-60';

export async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  );
}

/** Time zone, currency, slot length, capacity and weekly opening hours (one period a day). */
export function ReservationSettingsForm({
  settings,
  canEdit,
  onSave,
}: {
  settings: ReservationSettings;
  canEdit: boolean;
  onSave: (settings: ReservationSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function setDay(day: Weekday, open: boolean, start?: string, end?: string) {
    const current = draft.hours[day][0] ?? { start: '09:00', end: '18:00' };
    setDraft((d) => ({
      ...d,
      hours: { ...d.hours, [day]: open ? [{ start: start ?? current.start, end: end ?? current.end }] : [] },
    }));
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-sm font-medium text-slate-700">
          Time zone
          <input className={inputCls} disabled={!canEdit} value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Currency
          <select className={inputCls} disabled={!canEdit} value={draft.currency} onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Start times every
          <select
            className={inputCls}
            disabled={!canEdit}
            value={draft.slot_minutes}
            onChange={(e) => setDraft((d) => ({ ...d, slot_minutes: Number(e.target.value) }))}
          >
            {[10, 15, 20, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Bookings at the same time
          <input
            type="number"
            min={1}
            max={50}
            className={inputCls}
            disabled={!canEdit}
            value={draft.capacity}
            onChange={(e) => setDraft((d) => ({ ...d, capacity: Number(e.target.value) }))}
          />
        </label>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Opening hours</legend>
        <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
          {WEEKDAYS.map((day) => {
            const range = draft.hours[day][0];
            return (
              <li key={day} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <label className="inline-flex w-32 items-center gap-2 text-slate-700">
                  <input type="checkbox" disabled={!canEdit} checked={Boolean(range)} onChange={(e) => setDay(day, e.target.checked)} className="rounded text-indigo-600" />
                  {WEEKDAY_LABELS[day]}
                </label>
                {range ? (
                  <span className="inline-flex items-center gap-2">
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_LABELS[day]} opens`}
                      disabled={!canEdit}
                      value={range.start}
                      onChange={(e) => setDay(day, true, e.target.value)}
                      className="rounded-lg border-0 px-2 py-1 ring-1 ring-inset ring-slate-300"
                    />
                    to
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_LABELS[day]} closes`}
                      disabled={!canEdit}
                      value={range.end}
                      onChange={(e) => setDay(day, true, undefined, e.target.value)}
                      className="rounded-lg border-0 px-2 py-1 ring-1 ring-inset ring-slate-300"
                    />
                  </span>
                ) : (
                  <span className="text-slate-400">Closed</span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
      <ErrorText error={error} />
      {canEdit && (
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save hours
          </button>
          {saved && <span className="text-sm text-emerald-700">Saved. Callers get the new hours right away.</span>}
        </div>
      )}
    </form>
  );
}

type ServiceDraft = { name: string; duration_minutes: string; price: string; description: string; active: boolean };
const EMPTY: ServiceDraft = { name: '', duration_minutes: '30', price: '', description: '', active: true };

export function ServicesList({
  initial,
  currency,
  canEdit,
}: {
  initial: Service[];
  currency: string;
  canEdit: boolean;
}) {
  const api = useWorkspaceApi();
  const [services, setServices] = useState(initial);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<ServiceDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function edit(s?: Service) {
    setError(null);
    setEditing(s?.id ?? 'new');
    setDraft(
      s
        ? {
            name: s.name,
            duration_minutes: String(s.duration_minutes),
            price: s.price_cents === null ? '' : String(s.price_cents / 100),
            description: s.description ?? '',
            active: s.active,
          }
        : EMPTY
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = editing === 'new' ? null : editing;
      const { item } = await send(`${api}/services${id ? `?id=${id}` : ''}`, id ? 'PATCH' : 'POST', {
        ...draft,
        duration_minutes: Number(draft.duration_minutes),
      });
      setServices((list) => (id ? list.map((s) => (s.id === id ? item : s)) : [...list, item]));
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Service) {
    if (!window.confirm(`Remove “${s.name}”?`)) return;
    setError(null);
    try {
      const { result } = await send(`${api}/services?id=${s.id}`, 'DELETE');
      setServices((list) => (result === 'hidden' ? list.map((x) => (x.id === s.id ? { ...x, active: false } : x)) : list.filter((x) => x.id !== s.id)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const form = (
    <form onSubmit={save} className="space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium text-slate-700 sm:col-span-3">
          Service
          <input className={inputCls} required maxLength={120} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Dental cleaning" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Minutes
          <input type="number" min={5} max={480} className={inputCls} required value={draft.duration_minutes} onChange={(e) => setDraft((d) => ({ ...d, duration_minutes: e.target.value }))} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Price ({currency}) <span className="font-normal text-slate-400">optional</span>
          <input type="number" min={0} step="0.01" className={inputCls} value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} />
        </label>
        <label className="mt-6 inline-flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} className="rounded text-indigo-600" />
          Bookable
        </label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-3">
          Description <span className="font-normal text-slate-400">optional</span>
          <input className={inputCls} maxLength={1000} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
        </label>
      </div>
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryBtn}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save service
        </button>
        <button type="button" onClick={() => setEditing(null)} className="px-3 text-sm font-medium text-slate-600">
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
        {services.length === 0 && <li className="px-3 py-4 text-sm text-slate-400">No services yet.</li>}
        {services.map((s) =>
          editing === s.id ? (
            <li key={s.id} className="p-2">
              {form}
            </li>
          ) : (
            <li key={s.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className={`font-medium ${s.active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>{s.name}</p>
                <p className="text-xs text-slate-500">
                  {s.duration_minutes} min{s.price_cents !== null ? ` · ${formatPrice(s.price_cents, currency)}` : ''}
                  {s.description ? ` · ${s.description}` : ''}
                </p>
              </div>
              {canEdit && (
                <span className="flex gap-1">
                  <button onClick={() => edit(s)} aria-label={`Edit ${s.name}`} className="rounded p-1.5 text-slate-400 hover:text-slate-700">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => remove(s)} aria-label={`Remove ${s.name}`} className="rounded p-1.5 text-slate-400 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              )}
            </li>
          )
        )}
      </ul>
      {editing === 'new' && form}
      {canEdit && editing === null && (
        <button onClick={() => edit()} className={secondaryBtn}>
          <Plus className="h-4 w-4" /> Add service
        </button>
      )}
    </div>
  );
}
