// Agent modules (shared by server and UI): actions the agent takes during a call, backed by
// data the business manages in the studio. Each module adds Retell custom functions.

import type { TemplateId } from '@/lib/templates';

export type ModuleId = 'reservations' | 'rentals';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export type TimeRange = { start: string; end: string };

export type ReservationSettings = {
  timezone: string;
  currency: string;
  /** Minutes between possible start times. */
  slot_minutes: number;
  /** Appointments that can happen at the same time (doctors, tables, chairs). */
  capacity: number;
  /** Opening hours per weekday ("HH:MM", 24h); an empty list means closed. */
  hours: Record<Weekday, TimeRange[]>;
};

export type RentalSettings = {
  timezone: string;
  currency: string;
  check_in_time: string;
  check_out_time: string;
  /** Free cancellation until this many days before check-in. */
  cancel_free_days: number;
  /** After that, this share of the total is charged (100 = non-refundable). */
  cancel_fee_percent: number;
  /** Date, apartment and guest changes allowed until this many hours before check-in. */
  change_cutoff_hours: number;
  /** Anything else callers should hear about the policy. */
  policy_notes: string;
};

export type ModuleSettings = { reservations: ReservationSettings; rentals: RentalSettings };

export type ModuleState<M extends ModuleId = ModuleId> = { module: M; enabled: boolean; settings: ModuleSettings[M] };

export const MODULES: Record<ModuleId, { label: string; description: string; suggestedFor: TemplateId[] }> = {
  reservations: {
    label: 'Reservations',
    description: 'Your services, opening hours and a booking calendar. The agent checks open slots and books appointments during the call.',
    suggestedFor: ['clinic', 'restaurant', 'real_estate'],
  },
  rentals: {
    label: 'Short-term rentals',
    description: 'Your apartments with prices, address and house rules. The agent checks dates, quotes the stay and books it.',
    suggestedFor: ['rental'],
  },
};

export const CURRENCIES = ['USD', 'PHP', 'EUR'] as const;
export const DEFAULT_TIMEZONE = 'Asia/Manila';

const weekdays = (range: TimeRange[]) => ({ mon: range, tue: range, wed: range, thu: range, fri: range });

export function defaultSettings<M extends ModuleId>(module: M, timezone = DEFAULT_TIMEZONE): ModuleSettings[M] {
  const settings: ModuleSettings = {
    reservations: {
      timezone,
      currency: 'USD',
      slot_minutes: 30,
      capacity: 1,
      hours: { ...weekdays([{ start: '09:00', end: '18:00' }]), sat: [{ start: '09:00', end: '13:00' }], sun: [] },
    },
    rentals: {
      timezone,
      currency: 'USD',
      check_in_time: '14:00',
      check_out_time: '11:00',
      cancel_free_days: 7,
      cancel_fee_percent: 50,
      change_cutoff_hours: 24,
      policy_notes: '',
    },
  };
  return settings[module];
}

export function modulesForTemplate(template: string | null): ModuleId[] {
  return (Object.keys(MODULES) as ModuleId[]).filter((m) => MODULES[m].suggestedFor.includes(template as TemplateId));
}

/** Sample data so a new workspace can try booking on its first test call. */
export const SAMPLE_SERVICES: Partial<Record<TemplateId, { name: string; description: string; duration_minutes: number; price_cents: number }[]>> = {
  clinic: [
    { name: 'General consultation', description: 'Check-up with the doctor.', duration_minutes: 30, price_cents: 2500 },
    { name: 'Dental cleaning', description: 'Cleaning and polishing, about an hour.', duration_minutes: 60, price_cents: 5000 },
    { name: 'Follow-up visit', description: 'For returning patients.', duration_minutes: 20, price_cents: 1500 },
  ],
  restaurant: [
    { name: 'Table for up to 4', description: 'Dinner or lunch table, held for 90 minutes.', duration_minutes: 90, price_cents: 0 },
    { name: 'Table for 5 to 8', description: 'Large table, held for 2 hours.', duration_minutes: 120, price_cents: 0 },
  ],
  real_estate: [{ name: 'Property viewing', description: 'A guided visit of a listing.', duration_minutes: 45, price_cents: 0 }],
};

export const SAMPLE_RENTALS = [
  {
    name: 'Sunset Studio',
    description: 'Bright studio with a bay view, queen bed, kitchenette and fast Wi-Fi.',
    address: '1201 Roxas Boulevard, Pasay City',
    nightly_price_cents: 4500,
    max_guests: 2,
    bedrooms: 0,
    amenities: 'Wi-Fi, air conditioning, kitchenette, smart TV, pool access',
    rules: 'No smoking. No parties or events. Quiet hours 10 PM to 7 AM. No pets.',
  },
  {
    name: 'Garden Loft (2 bedrooms)',
    description: 'Two-bedroom loft with a private garden, good for families.',
    address: '45 Mahogany Street, Tagaytay City',
    nightly_price_cents: 8500,
    max_guests: 5,
    bedrooms: 2,
    amenities: 'Wi-Fi, full kitchen, washing machine, parking for one car, garden',
    rules: 'No smoking indoors. Pets allowed with a $20 cleaning fee. Quiet hours 10 PM to 7 AM.',
  },
];

// ---------------------------------------------------------------------------
// Time zone helpers (no date library): the business's local date and time <-> UTC instants.

function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: get('weekday').toLowerCase().slice(0, 3) as Weekday,
    seconds: Number(get('second')),
  };
}

/** The UTC instant of a local date ("YYYY-MM-DD") and time ("HH:MM") in a time zone. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  // Two passes settle DST edges
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), timeZone);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const [ph, pmin] = p.time.split(':').map(Number);
    guess += wanted - Date.UTC(py, pm - 1, pd, ph, pmin);
  }
  return new Date(guess);
}

/** Local date, time and weekday of an instant in a time zone. */
export function localParts(date: Date, timeZone: string) {
  const p = partsIn(date, timeZone);
  return { date: p.date, time: p.time, weekday: p.weekday };
}

export function weekdayOf(date: string): Weekday {
  // Noon UTC is the same calendar day in every time zone
  return WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function hhmmOf(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
