'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronLeft, ChevronRight, MapPin, Plus, Users } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { AddBookingForm, Agenda, Card } from '@/components/bookings/BookingParts';
import { ErrorText, secondaryBtn, send } from '@/components/studio/ServicesEditor';
import { formatPrice } from '@/lib/money';
import { hasRole } from '@/lib/workspace-roles';
import { addDays, localParts, weekdayOf, WEEKDAYS, zonedToUtc, type ModuleState } from '@/lib/modules-shared';
import type { Booking, Rental, Service } from '@/lib/bookings';

const POLL_MS = 15_000;
const NEW_FOR_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function mondayOf(date: string) {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

function shortDay(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-400">{note}</p>}
    </div>
  );
}

type Local = Booking & { day: string; endDay: string; time: string };

/**
 * Live view of a workspace's reservations: today at a glance, a week calendar, which
 * apartments are booked on which nights, the upcoming list, and what the agent offers.
 * Refreshes every 15 seconds while the tab is open, so bookings made by the agent appear.
 */
export default function BookingsDashboard({
  modules,
  services,
  rentals,
  initialBookings,
  connected,
}: {
  modules: ModuleState[];
  services: Service[];
  rentals: Rental[];
  initialBookings: Booking[];
  connected: boolean;
}) {
  const api = useWorkspaceApi();
  const { role, slug } = useWorkspace();
  const canEdit = hasRole(role, 'admin');
  const reservations = modules.find((m) => m.module === 'reservations');
  const rentalsModule = modules.find((m) => m.module === 'rentals');
  const timezone = (reservations ?? rentalsModule)!.settings.timezone;
  const currencies = { appointment: reservations?.settings.currency ?? 'USD', stay: rentalsModule?.settings.currency ?? 'USD' };

  const [today] = useState(() => localParts(new Date(), timezone).date);
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [bookings, setBookings] = useState(initialBookings);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = useRef(new Set(initialBookings.map((b) => b.id)));

  // Poll the week on screen plus the next 60 days while the tab is visible
  useEffect(() => {
    async function refresh() {
      const from = zonedToUtc(addDays(weekStart, -1), '00:00', timezone);
      const end = addDays(today, 61) > addDays(weekStart, 8) ? addDays(today, 61) : addDays(weekStart, 8);
      const to = zonedToUtc(end, '00:00', timezone);
      const res = await fetch(`${api}/bookings?from=${from.toISOString()}&to=${to.toISOString()}`);
      if (!res.ok) return;
      const list: Booking[] = (await res.json()).bookings;
      const arrived = list.filter((b) => !known.current.has(b.id)).map((b) => b.id);
      arrived.forEach((id) => known.current.add(id));
      if (arrived.length) {
        setFresh((s) => new Set([...s, ...arrived]));
        setTimeout(() => setFresh((s) => new Set([...s].filter((id) => !arrived.includes(id)))), NEW_FOR_MS);
      }
      setBookings(list);
      setUpdatedAt(new Date());
    }
    const tick = () => {
      if (document.visibilityState === 'visible') refresh().catch(() => {});
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [api, timezone, today, weekStart]);

  async function cancel(b: Booking) {
    if (!window.confirm(`Cancel ${b.item_name} for ${b.customer_name}?`)) return;
    try {
      await send(`${api}/bookings?id=${b.id}`, 'DELETE');
      setBookings((list) => list.map((x) => (x.id === b.id ? { ...x, status: 'cancelled' } : x)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Business-local dates and times for every booking
  const local: Local[] = bookings.map((b) => {
    const start = localParts(new Date(b.starts_at), timezone);
    return { ...b, day: start.date, time: start.time, endDay: localParts(new Date(b.ends_at), timezone).date };
  });
  const confirmed = local.filter((b) => b.status === 'confirmed');
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const in7 = addDays(today, 7);
  const in30 = addDays(today, 30);
  const upcoming = local.filter((b) => b.endDay >= today);
  const weekAgo = updatedAt ? updatedAt.getTime() - 7 * DAY_MS : 0;

  const appointmentsToday = confirmed.filter((b) => b.kind === 'appointment' && b.day === today).length;
  const checkInsToday = confirmed.filter((b) => b.kind === 'stay' && b.day === today).length;
  const checkOutsToday = confirmed.filter((b) => b.kind === 'stay' && b.endDay === today).length;
  const next7 = confirmed.filter((b) => b.day >= today && b.day < in7).length;
  const byAgent = confirmed.filter((b) => b.source === 'call' && Date.parse(b.created_at) >= weekAgo).length;
  const value = (['appointment', 'stay'] as const)
    .map((kind) => {
      const sum = confirmed.filter((b) => b.kind === kind && b.day >= today && b.day < in30).reduce((s, b) => s + (b.total_cents ?? 0), 0);
      return sum ? formatPrice(sum, currencies[kind]) : null;
    })
    .filter(Boolean)
    .join(' + ');

  return (
    <div className="space-y-6">
      {!connected && (
        <p className="flex gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          The agent can’t reach this calendar from this address yet (PUBLIC_APP_URL isn’t a public https address), so calls take details
          instead of booking. Bookings you add here still work.
        </p>
      )}
      <ErrorText error={error} />

      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 text-sm text-slate-600">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          Live
          {updatedAt && <span className="text-xs text-slate-400">· updated {updatedAt.toLocaleTimeString()}</span>}
        </span>
        <span className="text-xs text-slate-400">Times in {timezone}</span>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className={`${secondaryBtn} ml-auto`}>
            <Plus className="h-4 w-4" /> Add booking
          </button>
        )}
      </div>

      {adding && (
        <AddBookingForm
          modules={modules.map((m) => m.module)}
          services={services}
          rentals={rentals}
          onClose={() => setAdding(false)}
          onAdded={(b) => {
            known.current.add(b.id);
            setBookings((list) => [...list, b].sort((x, y) => x.starts_at.localeCompare(y.starts_at)));
            setAdding(false);
          }}
        />
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {reservations ? (
          <Stat label="Appointments today" value={String(appointmentsToday)} />
        ) : (
          <Stat label="Check-ins today" value={String(checkInsToday)} note={`${checkOutsToday} check-out${checkOutsToday === 1 ? '' : 's'}`} />
        )}
        <Stat label="Next 7 days" value={String(next7)} note="bookings starting" />
        <Stat label="Booked by the agent" value={String(byAgent)} note="last 7 days" />
        <Stat label="Booked value" value={value || '—'} note="next 30 days" />
      </div>

      <Card
        title={`Week of ${shortDay(weekStart, { month: 'short', day: 'numeric' })} – ${shortDay(addDays(weekStart, 6), { month: 'short', day: 'numeric' })}`}
        action={
          <div className="flex items-center gap-1">
            <button aria-label="Previous week" onClick={() => setWeekStart((w) => addDays(w, -7))} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => setWeekStart(mondayOf(today))} className="rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">
              This week
            </button>
            <button aria-label="Next week" onClick={() => setWeekStart((w) => addDays(w, 7))} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <div className="grid gap-2 sm:grid-cols-7">
          {week.map((day) => {
            const appointments = confirmed.filter((b) => b.kind === 'appointment' && b.day === day).sort((a, b) => a.time.localeCompare(b.time));
            const checkIns = confirmed.filter((b) => b.kind === 'stay' && b.day === day);
            const checkOuts = confirmed.filter((b) => b.kind === 'stay' && b.endDay === day);
            const isToday = day === today;
            return (
              <div key={day} className={`min-h-28 rounded-xl p-2 ring-1 ${isToday ? 'bg-indigo-50/60 ring-indigo-200' : day < today ? 'bg-slate-50 ring-slate-100' : 'ring-slate-200'}`}>
                <p className={`text-xs font-semibold ${isToday ? 'text-indigo-700' : 'text-slate-500'}`}>
                  {shortDay(day, { weekday: 'short', day: 'numeric' })}
                  {isToday && ' · today'}
                </p>
                <ul className="mt-1.5 space-y-1 text-xs">
                  {appointments.map((b) => (
                    <li
                      key={b.id}
                      title={[b.customer_phone, b.notes].filter(Boolean).join(' · ')}
                      className={`rounded-md px-1.5 py-1 ${fresh.has(b.id) ? 'bg-emerald-100 text-emerald-900' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
                    >
                      <span className="font-semibold tabular-nums">{b.time}</span> {b.item_name}
                      <span className="block truncate text-slate-500">{b.customer_name}</span>
                    </li>
                  ))}
                  {checkIns.map((b) => (
                    <li key={`in-${b.id}`} className={`rounded-md px-1.5 py-1 ${fresh.has(b.id) ? 'bg-emerald-100 text-emerald-900' : 'bg-indigo-600 text-white'}`}>
                      <span className="font-semibold">Check-in</span> {b.item_name}
                      <span className="block truncate opacity-80">
                        {b.customer_name}
                        {b.guests ? ` · ${b.guests}` : ''}
                      </span>
                    </li>
                  ))}
                  {checkOuts.map((b) => (
                    <li key={`out-${b.id}`} className="rounded-md bg-slate-100 px-1.5 py-1 text-slate-600">
                      <span className="font-semibold">Check-out</span> {b.item_name}
                    </li>
                  ))}
                  {!appointments.length && !checkIns.length && !checkOuts.length && <li className="text-slate-300">—</li>}
                </ul>
              </div>
            );
          })}
        </div>

        {rentalsModule && rentals.some((r) => r.active) && (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-[2px] text-xs">
              <caption className="mb-2 text-left text-xs font-semibold text-slate-500">Nights booked</caption>
              <thead>
                <tr>
                  <th scope="col" className="w-40 text-left font-medium text-slate-500">
                    Apartment
                  </th>
                  {week.map((day) => (
                    <th key={day} scope="col" className={`font-medium ${day === today ? 'text-indigo-700' : 'text-slate-500'}`}>
                      {shortDay(day, { weekday: 'narrow', day: 'numeric' })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rentals
                  .filter((r) => r.active)
                  .map((r) => (
                    <tr key={r.id}>
                      <th scope="row" className="truncate text-left font-medium text-slate-700">
                        {r.name}
                      </th>
                      {week.map((night) => {
                        // A night belongs to the stay from its check-in day up to the day before check-out
                        const stay = confirmed.find((b) => b.rental_id === r.id && b.day <= night && night < b.endDay);
                        return (
                          <td
                            key={night}
                            title={stay ? `${stay.customer_name}${stay.guests ? `, ${stay.guests} guests` : ''}` : 'Free'}
                            className={`h-7 truncate rounded px-1 ${stay ? (fresh.has(stay.id) ? 'bg-emerald-500 text-white' : 'bg-indigo-500 text-white') : 'bg-slate-100 text-slate-400'}`}
                          >
                            {stay ? (stay.day === night ? stay.customer_name.split(' ')[0] : '') : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="mt-2 flex items-center gap-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded bg-indigo-500" /> booked night
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded bg-slate-100 ring-1 ring-slate-200" /> free
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded bg-emerald-500" /> just booked
              </span>
            </p>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Upcoming">
            <Agenda bookings={upcoming} timezone={timezone} currencies={currencies} canEdit={canEdit} onCancel={cancel} highlight={fresh} />
          </Card>
        </div>

        <Card
          title="What you offer"
          action={
            canEdit && (
              <Link href={`/w/${slug}/modules`} className="text-xs font-medium text-indigo-600 hover:underline">
                Manage
              </Link>
            )
          }
        >
          <div className="space-y-5">
            {reservations && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Services</p>
                <ul className="mt-2 divide-y divide-slate-100 text-sm">
                  {services.filter((s) => s.active).length === 0 && <li className="py-2 text-slate-400">No services yet.</li>}
                  {services
                    .filter((s) => s.active)
                    .map((s) => (
                      <li key={s.id} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="min-w-0 text-slate-800">
                          {s.name}
                          <span className="block text-xs text-slate-500">{s.duration_minutes} min</span>
                        </span>
                        <span className="shrink-0 font-medium text-slate-900">
                          {s.price_cents ? formatPrice(s.price_cents, currencies.appointment) : 'Free'}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {rentalsModule && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Apartments</p>
                <ul className="mt-2 space-y-3 text-sm">
                  {rentals.filter((r) => r.active).length === 0 && <li className="text-slate-400">No apartments yet.</li>}
                  {rentals
                    .filter((r) => r.active)
                    .map((r) => (
                      <li key={r.id} className="rounded-xl p-3 ring-1 ring-slate-200">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-slate-900">{r.name}</span>
                          <span className="shrink-0 font-semibold text-slate-900">
                            {formatPrice(r.nightly_price_cents, currencies.stay)}
                            <span className="text-xs font-normal text-slate-500">/night</span>
                          </span>
                        </div>
                        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Users className="h-3 w-3" /> up to {r.max_guests}
                          </span>
                          {r.address && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> {r.address}
                            </span>
                          )}
                        </p>
                        {r.rules && <p className="mt-1 text-xs text-slate-600">Rules: {r.rules}</p>}
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
