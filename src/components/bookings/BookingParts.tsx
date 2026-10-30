'use client';

// Calendar pieces shared by the Bookings dashboard and the module setup.

import { useState } from 'react';
import { Loader2, Phone, X } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { ErrorText, inputCls, primaryBtn, send } from '@/components/studio/ServicesEditor';
import { formatPrice } from '@/lib/money';
import type { ModuleId } from '@/lib/modules-shared';
import type { Booking, Rental, Service } from '@/lib/bookings';

export function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function dayKey(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));
}

export function dayHeading(key: string) {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
}

export function timeIn(iso: string, timeZone: string) {
  return new Date(iso).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
}

/** Upcoming bookings as an agenda grouped by day, in the business's time zone. */
export function Agenda({
  bookings,
  timezone,
  currencies,
  canEdit,
  onCancel,
  highlight,
}: {
  bookings: Booking[];
  timezone: string;
  currencies: Record<'appointment' | 'stay', string>;
  canEdit: boolean;
  onCancel: (b: Booking) => void;
  /** Bookings that just arrived (shown with a "New" badge). */
  highlight?: Set<string>;
}) {
  const days = new Map<string, Booking[]>();
  for (const b of bookings) {
    const key = dayKey(b.starts_at, timezone);
    days.set(key, [...(days.get(key) ?? []), b]);
  }
  if (!days.size) return <p className="py-6 text-center text-sm text-slate-400">No upcoming bookings yet.</p>;
  return (
    <div className="space-y-5">
      {[...days].map(([key, list]) => (
        <div key={key}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{dayHeading(key)}</h3>
          <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
            {list.map((b) => {
              const cancelled = b.status === 'cancelled';
              return (
                <li key={b.id} className={`flex flex-wrap items-start gap-3 px-3 py-2.5 text-sm ${cancelled ? 'opacity-50' : ''}`}>
                  <span className="w-28 shrink-0 font-medium text-slate-900 tabular-nums">
                    {b.kind === 'stay' ? 'Check-in' : `${timeIn(b.starts_at, timezone)}`}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-slate-800 ${cancelled ? 'line-through' : ''}`}>
                      {highlight?.has(b.id) && (
                        <span className="mr-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          New
                        </span>
                      )}
                      {b.item_name} · {b.customer_name}
                      {b.guests ? ` · ${b.guests} guests` : ''}
                    </p>
                    <p className="text-xs text-slate-500">
                      {b.kind === 'stay'
                        ? `Until ${new Date(b.ends_at).toLocaleDateString(undefined, { timeZone: timezone, month: 'short', day: 'numeric' })}`
                        : `Until ${timeIn(b.ends_at, timezone)}`}
                      {b.customer_phone && (
                        <>
                          {' · '}
                          <Phone className="inline h-3 w-3" /> {b.customer_phone}
                        </>
                      )}
                      {b.total_cents ? ` · ${formatPrice(b.total_cents, currencies[b.kind])}` : ''}
                      {` · ref ${b.id.slice(0, 8).toUpperCase()}`}
                      {` · ${b.source === 'call' ? 'booked by the agent' : 'added by the team'}`}
                      {cancelled && ' · cancelled'}
                    </p>
                    {b.notes && <p className="text-xs text-slate-500">Note: {b.notes}</p>}
                  </div>
                  {canEdit && !cancelled && (
                    <button onClick={() => onCancel(b)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-500 hover:text-red-600">
                      <X className="h-3.5 w-3.5" /> Cancel
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AddBookingForm({
  modules,
  services,
  rentals,
  onAdded,
  onClose,
}: {
  modules: ModuleId[];
  services: Service[];
  rentals: Rental[];
  onAdded: (b: Booking) => void;
  onClose: () => void;
}) {
  const api = useWorkspaceApi();
  const [kind, setKind] = useState<'appointment' | 'stay'>(modules.includes('reservations') ? 'appointment' : 'stay');
  const [form, setForm] = useState({ item: '', date: '', time: '', check_out: '', guests: '2', customer_name: '', customer_phone: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const items = kind === 'appointment' ? services.filter((s) => s.active) : rentals.filter((r) => r.active);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body =
        kind === 'appointment'
          ? { kind, service: form.item, date: form.date, time: form.time, customer_name: form.customer_name, customer_phone: form.customer_phone, notes: form.notes }
          : {
              kind,
              apartment: form.item,
              check_in: form.date,
              check_out: form.check_out,
              guests: Number(form.guests),
              customer_name: form.customer_name,
              customer_phone: form.customer_phone,
              notes: form.notes,
            };
      const { booking } = await send(`${api}/bookings`, 'POST', body);
      onAdded(booking);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-5 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      {modules.length > 1 && (
        <div className="flex gap-2 text-sm">
          {(['appointment', 'stay'] as const).map((k) => (
            <label key={k} className="inline-flex items-center gap-1.5">
              <input type="radio" checked={kind === k} onChange={() => setKind(k)} className="text-indigo-600" />
              {k === 'appointment' ? 'Appointment' : 'Stay'}
            </label>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
          {kind === 'appointment' ? 'Service' : 'Apartment'}
          <select className={inputCls} required value={form.item} onChange={set('item')}>
            <option value="">Choose…</option>
            {items.map((i) => (
              <option key={i.id} value={i.name}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          {kind === 'appointment' ? 'Date' : 'Check-in'}
          <input type="date" required className={inputCls} value={form.date} onChange={set('date')} />
        </label>
        {kind === 'appointment' ? (
          <label className="block text-sm font-medium text-slate-700">
            Time
            <input type="time" required className={inputCls} value={form.time} onChange={set('time')} />
          </label>
        ) : (
          <label className="block text-sm font-medium text-slate-700">
            Check-out
            <input type="date" required className={inputCls} value={form.check_out} onChange={set('check_out')} />
          </label>
        )}
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
          Name
          <input required maxLength={120} className={inputCls} value={form.customer_name} onChange={set('customer_name')} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Mobile <span className="font-normal text-slate-400">optional</span>
          <input maxLength={40} className={inputCls} value={form.customer_phone} onChange={set('customer_phone')} />
        </label>
        {kind === 'stay' && (
          <label className="block text-sm font-medium text-slate-700">
            Guests
            <input type="number" min={1} max={50} required className={inputCls} value={form.guests} onChange={set('guests')} />
          </label>
        )}
        <label className="block text-sm font-medium text-slate-700 sm:col-span-4">
          Note <span className="font-normal text-slate-400">optional</span>
          <input maxLength={1000} className={inputCls} value={form.notes} onChange={set('notes')} />
        </label>
      </div>
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryBtn}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add booking
        </button>
        <button type="button" onClick={onClose} className="px-3 text-sm font-medium text-slate-600">
          Cancel
        </button>
      </div>
    </form>
  );
}
