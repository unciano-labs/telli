'use client';

import { useState } from 'react';
import { Loader2, MapPin, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { ErrorText, inputCls, primaryBtn, secondaryBtn, send } from '@/components/studio/ServicesEditor';
import { formatPrice } from '@/lib/money';
import { CURRENCIES, type RentalSettings } from '@/lib/modules-shared';
import type { Rental } from '@/lib/bookings';

export function RentalSettingsForm({
  settings,
  canEdit,
  onSave,
}: {
  settings: RentalSettings;
  canEdit: boolean;
  onSave: (settings: RentalSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof RentalSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setDraft((d) => ({ ...d, [key]: e.target.value }));
    setSaved(false);
  };

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
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-sm font-medium text-slate-700">
          Time zone
          <input className={inputCls} disabled={!canEdit} value={draft.timezone} onChange={set('timezone')} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Currency
          <select className={inputCls} disabled={!canEdit} value={draft.currency} onChange={set('currency')}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Check-in from
          <input type="time" className={inputCls} disabled={!canEdit} value={draft.check_in_time} onChange={set('check_in_time')} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Check-out by
          <input type="time" className={inputCls} disabled={!canEdit} value={draft.check_out_time} onChange={set('check_out_time')} />
        </label>
      </div>
      <ErrorText error={error} />
      {canEdit && (
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
          {saved && <span className="text-sm text-emerald-700">Saved.</span>}
        </div>
      )}
    </form>
  );
}

type Draft = Record<'name' | 'nightly_price' | 'max_guests' | 'bedrooms' | 'address' | 'description' | 'amenities' | 'rules', string> & {
  active: boolean;
};
const EMPTY: Draft = {
  name: '',
  nightly_price: '',
  max_guests: '2',
  bedrooms: '1',
  address: '',
  description: '',
  amenities: '',
  rules: '',
  active: true,
};

export function RentalsList({ initial, currency, canEdit }: { initial: Rental[]; currency: string; canEdit: boolean }) {
  const api = useWorkspaceApi();
  const [rentals, setRentals] = useState(initial);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  function edit(r?: Rental) {
    setError(null);
    setEditing(r?.id ?? 'new');
    setDraft(
      r
        ? {
            name: r.name,
            nightly_price: String(r.nightly_price_cents / 100),
            max_guests: String(r.max_guests),
            bedrooms: r.bedrooms === null ? '' : String(r.bedrooms),
            address: r.address ?? '',
            description: r.description ?? '',
            amenities: r.amenities ?? '',
            rules: r.rules ?? '',
            active: r.active,
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
      const { item } = await send(`${api}/rentals${id ? `?id=${id}` : ''}`, id ? 'PATCH' : 'POST', {
        ...draft,
        max_guests: Number(draft.max_guests),
        bedrooms: draft.bedrooms === '' ? null : Number(draft.bedrooms),
      });
      setRentals((list) => (id ? list.map((r) => (r.id === id ? item : r)) : [...list, item]));
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Rental) {
    if (!window.confirm(`Remove “${r.name}”?`)) return;
    setError(null);
    try {
      const { result } = await send(`${api}/rentals?id=${r.id}`, 'DELETE');
      setRentals((list) => (result === 'hidden' ? list.map((x) => (x.id === r.id ? { ...x, active: false } : x)) : list.filter((x) => x.id !== r.id)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const form = (
    <form onSubmit={save} className="space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
          Name
          <input className={inputCls} required maxLength={120} value={draft.name} onChange={set('name')} placeholder="Sunset Studio" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Per night ({currency})
          <input type="number" min={0} step="0.01" required className={inputCls} value={draft.nightly_price} onChange={set('nightly_price')} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Max guests
          <input type="number" min={1} max={50} required className={inputCls} value={draft.max_guests} onChange={set('max_guests')} />
        </label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-3">
          Address
          <input className={inputCls} maxLength={300} value={draft.address} onChange={set('address')} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Bedrooms <span className="font-normal text-slate-400">0 = studio</span>
          <input type="number" min={0} max={50} className={inputCls} value={draft.bedrooms} onChange={set('bedrooms')} />
        </label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-4">
          Description
          <textarea rows={2} className={inputCls} maxLength={2000} value={draft.description} onChange={set('description')} />
        </label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
          Amenities
          <textarea rows={2} className={inputCls} maxLength={1000} value={draft.amenities} onChange={set('amenities')} placeholder="Wi-Fi, parking, pool" />
        </label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
          House rules
          <textarea rows={2} className={inputCls} maxLength={2000} value={draft.rules} onChange={set('rules')} placeholder="No smoking. Quiet hours 10 PM to 7 AM." />
        </label>
      </div>
      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} className="rounded text-indigo-600" />
        Bookable
      </label>
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryBtn}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save apartment
        </button>
        <button type="button" onClick={() => setEditing(null)} className="px-3 text-sm font-medium text-slate-600">
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div className="space-y-3">
      <ul className="grid gap-3 md:grid-cols-2">
        {rentals.length === 0 && <li className="text-sm text-slate-400">No apartments yet.</li>}
        {rentals.map((r) =>
          editing === r.id ? (
            <li key={r.id} className="md:col-span-2">
              {form}
            </li>
          ) : (
            <li key={r.id} className="rounded-xl p-4 text-sm ring-1 ring-slate-200">
              <div className="flex items-start gap-2">
                <p className={`min-w-0 flex-1 font-medium ${r.active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>{r.name}</p>
                <p className="font-semibold text-slate-900">
                  {formatPrice(r.nightly_price_cents, currency)}
                  <span className="text-xs font-normal text-slate-500">/night</span>
                </p>
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3" /> up to {r.max_guests}
                  {r.bedrooms !== null && ` · ${r.bedrooms === 0 ? 'studio' : `${r.bedrooms} BR`}`}
                </span>
                {r.address && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> {r.address}
                  </span>
                )}
              </p>
              {r.rules && <p className="mt-2 text-xs text-slate-600">Rules: {r.rules}</p>}
              {canEdit && (
                <div className="mt-2 flex gap-1">
                  <button onClick={() => edit(r)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-500 hover:text-slate-800">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button onClick={() => remove(r)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-500 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                </div>
              )}
            </li>
          )
        )}
      </ul>
      {editing === 'new' && form}
      {canEdit && editing === null && (
        <button onClick={() => edit()} className={secondaryBtn}>
          <Plus className="h-4 w-4" /> Add apartment
        </button>
      )}
    </div>
  );
}
