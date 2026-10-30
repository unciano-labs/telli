import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { saveDraft } from '@/lib/agent-draft';
import { getModuleStates } from '@/lib/modules-agent';
import { formatPrice } from '@/lib/money';
import { rateLimit } from '@/lib/rate-limit';
import {
  addDays,
  CURRENCIES,
  defaultSettings,
  HHMM,
  hhmmOf,
  isTimeZone,
  ISO_DATE,
  localParts,
  minutesOf,
  MODULES,
  SAMPLE_RENTALS,
  SAMPLE_SERVICES,
  WEEKDAYS,
  weekdayOf,
  zonedToUtc,
  type ModuleId,
  type ModuleState,
  type RentalSettings,
  type ReservationSettings,
  type TimeRange,
} from '@/lib/modules-shared';
import type { TemplateId } from '@/lib/templates';
import type { Workspace } from '@/lib/workspaces';

// Reservations (services + opening hours → appointments) and short-term rentals (apartments →
// stays). The agent uses these through /api/agent-tools during calls; the team manages them
// in Agent → Bookings.

export class BookingError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export type Service = {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price_cents: number | null;
  active: boolean;
  sort: number;
};

export type Rental = {
  id: string;
  name: string;
  /** Short code the business uses, e.g. "ALPA 105". */
  code: string | null;
  description: string | null;
  address: string | null;
  nightly_price_cents: number;
  max_guests: number;
  bedrooms: number | null;
  amenities: string | null;
  rules: string | null;
  /** Public extra details (parking, check-in steps, transport): the agent may tell anyone. */
  details: string | null;
  active: boolean;
  sort: number;
};

/** Never in public lists: guest_info goes only to verified guests, internal_notes never to the agent. */
export type RentalPrivate = { guest_info: string | null; internal_notes: string | null };

export type Booking = {
  id: string;
  /** 6 digits, unique in the workspace: what callers say to find their booking. */
  reference: string;
  kind: 'appointment' | 'stay';
  service_id: string | null;
  rental_id: string | null;
  /** Service or apartment name. */
  item_name: string;
  starts_at: string;
  ends_at: string;
  customer_name: string;
  customer_phone: string | null;
  guests: number | null;
  notes: string | null;
  total_cents: number | null;
  status: 'confirmed' | 'cancelled';
  source: 'call' | 'manual';
  /** Set when a cancellation fell outside free cancellation. */
  cancellation_fee_cents: number | null;
  history: BookingEvent[];
  created_at: string;
};

export type BookingEvent = { at: string; by: 'call' | 'manual'; action: 'changed' | 'cancelled'; summary: string };

const MAX_ITEMS = 50;
const MAX_STAY_NIGHTS = 30;
const MAX_DAYS_AHEAD = 365;
/** Appointments must start at least this far from now. */
const MIN_NOTICE_MINUTES = 15;

function db() {
  return createAdminClient();
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const optional = (value: unknown, max: number) => text(value, max) || null;

// ---------------------------------------------------------------------------
// Modules

export async function getModule<M extends ModuleId>(workspaceId: string, module: M): Promise<ModuleState<M> | null> {
  return ((await getModuleStates(workspaceId)).find((m) => m.module === module) as ModuleState<M> | undefined) ?? null;
}

function validateSettings(module: ModuleId, raw: Record<string, unknown>, current: ModuleState['settings']) {
  const timezone = raw.timezone ?? current.timezone;
  if (!isTimeZone(timezone)) throw new BookingError('Choose a valid time zone', 400);
  const currency = (raw.currency ?? current.currency) as string;
  if (!(CURRENCIES as readonly string[]).includes(currency)) throw new BookingError('Choose USD, PHP or EUR', 400);

  if (module === 'rentals') {
    const cur = current as RentalSettings;
    const checkIn = (raw.check_in_time ?? cur.check_in_time) as string;
    const checkOut = (raw.check_out_time ?? cur.check_out_time) as string;
    if (!HHMM.test(checkIn) || !HHMM.test(checkOut)) throw new BookingError('Check-in and check-out times are HH:MM', 400);
    const int = (key: keyof RentalSettings, min: number, max: number, label: string) => {
      const n = Number(raw[key] ?? cur[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw new BookingError(`${label}: ${min}–${max}`, 400);
      return n;
    };
    const notes = text(raw.policy_notes ?? cur.policy_notes ?? '', 1000);
    return {
      timezone,
      currency,
      check_in_time: checkIn,
      check_out_time: checkOut,
      cancel_free_days: int('cancel_free_days', 0, 365, 'Free cancellation days'),
      cancel_fee_percent: int('cancel_fee_percent', 0, 100, 'Late cancellation fee (%)'),
      change_cutoff_hours: int('change_cutoff_hours', 0, 720, 'Hours before check-in for changes'),
      policy_notes: notes,
    } satisfies RentalSettings;
  }

  const cur = current as ReservationSettings;
  const slot = Number(raw.slot_minutes ?? cur.slot_minutes);
  const capacity = Number(raw.capacity ?? cur.capacity);
  if (![10, 15, 20, 30, 45, 60, 90, 120].includes(slot)) throw new BookingError('Choose a slot length', 400);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) throw new BookingError('Bookings at the same time: 1–50', 400);
  const hoursRaw = (raw.hours ?? cur.hours) as Record<string, unknown>;
  const hours = {} as ReservationSettings['hours'];
  for (const day of WEEKDAYS) {
    const ranges = Array.isArray(hoursRaw?.[day]) ? (hoursRaw[day] as TimeRange[]) : [];
    if (ranges.length > 3) throw new BookingError('Up to 3 opening periods a day', 400);
    hours[day] = ranges.map((r) => {
      if (!HHMM.test(r?.start) || !HHMM.test(r?.end) || minutesOf(r.end) <= minutesOf(r.start)) {
        throw new BookingError('Opening hours need a start before the end, as HH:MM', 400);
      }
      return { start: r.start, end: r.end };
    });
  }
  return { timezone, currency, slot_minutes: slot, capacity, hours } satisfies ReservationSettings;
}

/**
 * Turns a module on or off, or changes its settings. The prompt and the agent functions are
 * rebuilt into the draft (live after Publish).
 */
export async function updateModule(
  workspace: Workspace,
  userId: string,
  module: ModuleId,
  patch: { enabled?: boolean; settings?: Record<string, unknown> }
): Promise<ModuleState> {
  if (!(module in MODULES)) throw new BookingError('Unknown module', 400);
  const current = (await getModule(workspace.id, module)) ?? { module, enabled: false, settings: defaultSettings(module) };
  const enabled = patch.enabled ?? current.enabled;
  const settings = patch.settings ? validateSettings(module, patch.settings, current.settings) : current.settings;
  const { error } = await db()
    .from('va_workspace_modules')
    .upsert(
      { website_id: WEBSITE_ID, workspace_id: workspace.id, module, enabled, settings, updated_at: new Date().toISOString() },
      { onConflict: 'workspace_id,module' }
    );
  if (error) throw new Error(`Failed to save the module: ${error.message}`);

  // Time zone and on/off change the prompt; hours and capacity don't (functions read them live)
  if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
    await saveDraft(workspace, userId, {}, `${enabled ? 'Turned on' : 'Turned off'} ${MODULES[module].label}`);
  } else if (settings.timezone !== current.settings.timezone && enabled) {
    await saveDraft(workspace, userId, {}, `Changed the ${MODULES[module].label} time zone to ${settings.timezone}`);
  }
  return { module, enabled, settings } as ModuleState;
}

/**
 * At onboarding, before the agent exists: saves the chosen modules, with sample services or
 * apartments so the first test call can book something. The agent is created with them.
 */
export async function setUpModules(workspace: Workspace, modules: ModuleId[], withSamples: boolean, timezone: string) {
  for (const id of modules) {
    const { error } = await db().from('va_workspace_modules').upsert(
      {
        website_id: WEBSITE_ID,
        workspace_id: workspace.id,
        module: id,
        enabled: true,
        settings: defaultSettings(id, isTimeZone(timezone) ? timezone : undefined),
      },
      { onConflict: 'workspace_id,module' }
    );
    if (error) throw new Error(`Failed to set up ${id}: ${error.message}`);
    if (!withSamples) continue;
    if (id === 'reservations') {
      const samples = SAMPLE_SERVICES[(workspace.template ?? 'clinic') as TemplateId] ?? SAMPLE_SERVICES.clinic!;
      await db()
        .from('va_services')
        .insert(samples.map((s, i) => ({ website_id: WEBSITE_ID, workspace_id: workspace.id, ...s, sort: i })));
    } else {
      await db()
        .from('va_rentals')
        .insert(SAMPLE_RENTALS.map((r, i) => ({ website_id: WEBSITE_ID, workspace_id: workspace.id, ...r, sort: i })));
    }
  }
}

// ---------------------------------------------------------------------------
// Services and apartments

export async function listServices(workspaceId: string, activeOnly = false): Promise<Service[]> {
  let query = db()
    .from('va_services')
    .select('id, name, description, duration_minutes, price_cents, active, sort')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .order('sort')
    .order('created_at');
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load services: ${error.message}`);
  return data as Service[];
}

export async function listRentals(workspaceId: string, activeOnly = false): Promise<Rental[]> {
  let query = db()
    .from('va_rentals')
    .select('id, name, code, description, address, nightly_price_cents, max_guests, bedrooms, amenities, rules, details, active, sort')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .order('sort')
    .order('created_at');
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load apartments: ${error.message}`);
  return data as Rental[];
}

function cents(value: unknown, label: string, required: boolean): number | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new BookingError(`${label} is required`, 400);
    return null;
  }
  const n = Math.round(Number(value) * 100);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new BookingError(`${label} must be a positive amount`, 400);
  return n;
}

/** Body uses whole currency units for prices ("45" or "45.50"). */
export function validateService(body: Record<string, unknown>) {
  const name = text(body.name, 120);
  if (!name) throw new BookingError('Service name is required', 400);
  const duration = Number(body.duration_minutes);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new BookingError('Duration: 5–480 minutes', 400);
  return {
    name,
    description: optional(body.description, 1000),
    duration_minutes: duration,
    price_cents: cents(body.price, 'Price', false),
    active: body.active !== false,
  };
}

export function validateRental(body: Record<string, unknown>) {
  const name = text(body.name, 120);
  if (!name) throw new BookingError('Apartment name is required', 400);
  const maxGuests = Number(body.max_guests);
  if (!Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > 50) throw new BookingError('Max guests: 1–50', 400);
  const bedrooms = body.bedrooms === '' || body.bedrooms === null || body.bedrooms === undefined ? null : Number(body.bedrooms);
  if (bedrooms !== null && (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 50)) throw new BookingError('Bedrooms: 0–50', 400);
  return {
    name,
    description: optional(body.description, 2000),
    address: optional(body.address, 300),
    nightly_price_cents: cents(body.nightly_price, 'Price per night', true)!,
    max_guests: maxGuests,
    bedrooms,
    amenities: optional(body.amenities, 1000),
    rules: optional(body.rules, 2000),
    code: optional(body.code, 40),
    details: optional(body.details, 6000),
    active: body.active !== false,
  };
}

export async function getRentalPrivate(workspace: Workspace, rentalId: string): Promise<RentalPrivate> {
  const { data, error } = await db()
    .from('va_rental_private')
    .select('guest_info, internal_notes')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('rental_id', rentalId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load private details: ${error.message}`);
  return (data as RentalPrivate) ?? { guest_info: null, internal_notes: null };
}

export async function saveRentalPrivate(workspace: Workspace, rentalId: string, body: Record<string, unknown>): Promise<RentalPrivate> {
  const rental = (await listRentals(workspace.id)).find((r) => r.id === rentalId);
  if (!rental) throw new BookingError('Apartment not found', 404);
  const fields = { guest_info: optional(body.guest_info, 6000), internal_notes: optional(body.internal_notes, 6000) };
  const { error } = await db()
    .from('va_rental_private')
    .upsert(
      { rental_id: rentalId, website_id: WEBSITE_ID, workspace_id: workspace.id, ...fields, updated_at: new Date().toISOString() },
      { onConflict: 'rental_id' }
    );
  if (error) throw new Error(`Failed to save private details: ${error.message}`);
  return fields;
}

type Table = 'va_services' | 'va_rentals';

export async function saveItem(workspace: Workspace, table: Table, id: string | null, fields: Record<string, unknown>) {
  if (!id) {
    const { count } = await db().from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id);
    if ((count ?? 0) >= MAX_ITEMS) throw new BookingError(`Up to ${MAX_ITEMS}`, 400);
  }
  const query = id
    ? db().from(table).update(fields).eq('website_id', WEBSITE_ID).eq('workspace_id', workspace.id).eq('id', id)
    : db().from(table).insert({ website_id: WEBSITE_ID, workspace_id: workspace.id, ...fields, sort: Date.now() % 1_000_000 });
  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw new Error(`Failed to save: ${error.message}`);
  if (!data) throw new BookingError('Not found', 404);
  return data;
}

/** Deletes a service or apartment; one with bookings is hidden instead, so its history stays. */
export async function deleteItem(workspace: Workspace, table: Table, id: string): Promise<'deleted' | 'hidden'> {
  const { error, count } = await db()
    .from(table)
    .delete({ count: 'exact' })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id);
  if (!error) {
    if (!count) throw new BookingError('Not found', 404);
    return 'deleted';
  }
  // 23503: bookings point at it
  if (error.code !== '23503') throw new Error(`Failed to delete: ${error.message}`);
  await db().from(table).update({ active: false }).eq('workspace_id', workspace.id).eq('id', id);
  return 'hidden';
}

// ---------------------------------------------------------------------------
// Bookings

const BOOKING_COLUMNS =
  'id, reference, kind, service_id, rental_id, starts_at, ends_at, customer_name, customer_phone, guests, notes, total_cents, status, source, cancellation_fee_cents, history, created_at, va_services(name), va_rentals(name)';

type BookingRow = Omit<Booking, 'item_name'> & { va_services: { name: string } | null; va_rentals: { name: string } | null };

function toBooking({ va_services, va_rentals, ...row }: BookingRow): Booking {
  return { ...row, item_name: va_services?.name ?? va_rentals?.name ?? '' };
}

export async function listBookings(workspaceId: string, from: Date, to: Date): Promise<Booking[]> {
  const { data, error } = await db()
    .from('va_bookings')
    .select(BOOKING_COLUMNS)
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .lt('starts_at', to.toISOString())
    .gt('ends_at', from.toISOString())
    .order('starts_at')
    .limit(500);
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  return (data as unknown as BookingRow[]).map(toBooking);
}

/** The Bookings dashboard's window: the past week (for this week's calendar) through the next 60 days. */
export async function listDashboardBookings(workspaceId: string): Promise<Booking[]> {
  const day = 24 * 60 * 60 * 1000;
  return listBookings(workspaceId, new Date(Date.now() - 8 * day), new Date(Date.now() + 61 * day));
}

export async function cancelBooking(workspace: Workspace, id: string): Promise<void> {
  const existing = await findBooking(workspace.id, id);
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('va_bookings')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      updated_at: now,
      history: [...(existing?.history ?? []), { at: now, by: 'manual', action: 'cancelled', summary: 'Cancelled by the team' }],
    })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .eq('status', 'confirmed')
    .select('id');
  if (error) throw new Error(`Failed to cancel: ${error.message}`);
  if (!data.length) throw new BookingError('Booking not found or already cancelled', 404);
}

function findByName<T extends { name: string; code?: string | null }>(items: T[], name: string): T | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  // Codes like "ALPA 105" are matched ignoring spaces and dashes
  const compact = (v: string) => v.toLowerCase().replace(/[\s\-/]+/g, '');
  return (
    items.find((i) => i.name.toLowerCase() === wanted) ??
    items.find((i) => i.code && compact(i.code) === compact(wanted)) ??
    items.find((i) => i.name.toLowerCase().includes(wanted) || wanted.includes(i.name.toLowerCase())) ??
    null
  );
}

function todayIn(timezone: string) {
  return localParts(new Date(), timezone).date;
}

function assertDate(date: unknown, label: string, timezone: string): string {
  if (typeof date !== 'string' || !ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) {
    throw new BookingError(`${label} must be a date like 2026-11-20`, 400);
  }
  const today = todayIn(timezone);
  if (date < today) throw new BookingError(`${label} is in the past (today is ${today})`, 400);
  if (date > addDays(today, MAX_DAYS_AHEAD)) throw new BookingError(`${label} is more than a year away`, 400);
  return date;
}

/** Free start times ("HH:MM") for a service on a date, in the business's time zone. */
export async function appointmentSlots(workspaceId: string, settings: ReservationSettings, service: Service, date: string): Promise<string[]> {
  const ranges = settings.hours[weekdayOf(date)] ?? [];
  if (!ranges.length) return [];
  const tz = settings.timezone;
  const earliest = Date.now() + MIN_NOTICE_MINUTES * 60_000;
  const candidates: { time: string; start: number; end: number }[] = [];
  for (const range of ranges) {
    for (let t = minutesOf(range.start); t + service.duration_minutes <= minutesOf(range.end); t += settings.slot_minutes) {
      const start = zonedToUtc(date, hhmmOf(t), tz).getTime();
      if (start >= earliest) candidates.push({ time: hhmmOf(t), start, end: start + service.duration_minutes * 60_000 });
    }
  }
  if (!candidates.length) return [];

  const { data, error } = await db()
    .from('va_bookings')
    .select('starts_at, ends_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('kind', 'appointment')
    .eq('status', 'confirmed')
    .lt('starts_at', new Date(candidates.at(-1)!.end).toISOString())
    .gt('ends_at', new Date(candidates[0].start).toISOString());
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  const taken = (data ?? []).map((b) => [Date.parse(b.starts_at), Date.parse(b.ends_at)]);
  return candidates
    .filter((c) => taken.filter(([s, e]) => s < c.end && e > c.start).length < settings.capacity)
    .map((c) => c.time);
}

type Customer = { name: string; phone: string | null; notes: string | null };

function customer(args: Record<string, unknown>, phoneRequired: boolean): Customer {
  const name = text(args.customer_name, 120);
  const phone = optional(args.customer_phone, 40);
  if (!name) throw new BookingError('The customer’s name is required', 400);
  if (phoneRequired && !phone) throw new BookingError('The customer’s mobile number is required', 400);
  return { name, phone, notes: optional(args.notes, 1000) };
}

export async function bookAppointment(
  workspace: Workspace,
  args: Record<string, unknown>,
  origin: { source: 'call' | 'manual'; callId?: string | null; userId?: string | null }
): Promise<Booking> {
  const mod = await getModule(workspace.id, 'reservations');
  if (!mod?.enabled) throw new BookingError('Reservations are turned off', 400);
  const settings = mod.settings;
  const service = findByName(await listServices(workspace.id, true), text(args.service, 120));
  if (!service) throw new BookingError('Unknown service', 400);
  const date = assertDate(args.date, 'The date', settings.timezone);
  const time = text(args.time, 5);
  if (!HHMM.test(time)) throw new BookingError('The time must be HH:MM', 400);
  const who = customer(args, origin.source === 'call');
  // Staff may book outside the grid; callers only get offered slots
  if (origin.source === 'call' && !(await appointmentSlots(workspace.id, settings, service, date)).includes(time)) {
    throw new BookingError('That time isn’t available', 409);
  }
  const startsAt = zonedToUtc(date, time, settings.timezone);
  const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60_000);

  const { data: id, error } = await db().rpc('va_book_appointment', {
    p_website_id: WEBSITE_ID,
    p_workspace_id: workspace.id,
    p_service_id: service.id,
    p_starts_at: startsAt.toISOString(),
    p_ends_at: endsAt.toISOString(),
    p_capacity: settings.capacity,
    p_customer_name: who.name,
    p_customer_phone: who.phone,
    p_guests: null,
    p_notes: who.notes,
    p_total_cents: service.price_cents,
    p_source: origin.source,
    p_retell_call_id: origin.callId ?? null,
    p_created_by: origin.userId ?? null,
  });
  if (error) throw new Error(`Failed to book: ${error.message}`);
  if (!id) throw new BookingError('That time was just taken', 409);
  return (await findBooking(workspace.id, id as string))!;
}

async function findBooking(workspaceId: string, id: string): Promise<Booking | null> {
  const { data } = await db().from('va_bookings').select(BOOKING_COLUMNS).eq('workspace_id', workspaceId).eq('id', id).maybeSingle();
  return data ? toBooking(data as unknown as BookingRow) : null;
}

function nightsBetween(checkIn: string, checkOut: string) {
  return Math.round((Date.parse(`${checkOut}T12:00:00Z`) - Date.parse(`${checkIn}T12:00:00Z`)) / 86_400_000);
}

export type StayOption = { rental: Rental; nights: number; total_cents: number };

/** Apartments free for the whole stay that fit the guests. */
export async function stayOptions(
  workspaceId: string,
  settings: RentalSettings,
  input: { check_in: string; check_out: string; guests: number; apartment?: string | null }
): Promise<StayOption[]> {
  const nights = nightsBetween(input.check_in, input.check_out);
  if (nights < 1) throw new BookingError('Check-out must be after check-in', 400);
  if (nights > MAX_STAY_NIGHTS) throw new BookingError(`Stays are up to ${MAX_STAY_NIGHTS} nights`, 400);
  let rentals = (await listRentals(workspaceId, true)).filter((r) => r.max_guests >= input.guests);
  if (input.apartment) {
    const match = findByName(rentals, input.apartment);
    rentals = match ? [match] : [];
  }
  if (!rentals.length) return [];

  const startsAt = zonedToUtc(input.check_in, settings.check_in_time, settings.timezone).toISOString();
  const endsAt = zonedToUtc(input.check_out, settings.check_out_time, settings.timezone).toISOString();
  const { data, error } = await db()
    .from('va_bookings')
    .select('rental_id')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('kind', 'stay')
    .eq('status', 'confirmed')
    .lt('starts_at', endsAt)
    .gt('ends_at', startsAt);
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  const busy = new Set((data ?? []).map((b) => b.rental_id));
  return rentals.filter((r) => !busy.has(r.id)).map((rental) => ({ rental, nights, total_cents: nights * rental.nightly_price_cents }));
}

function guestsOf(value: unknown) {
  const guests = Number(value);
  if (!Number.isInteger(guests) || guests < 1 || guests > 50) throw new BookingError('Number of guests: 1–50', 400);
  return guests;
}

export async function bookStay(
  workspace: Workspace,
  args: Record<string, unknown>,
  origin: { source: 'call' | 'manual'; callId?: string | null; userId?: string | null }
): Promise<Booking> {
  const mod = await getModule(workspace.id, 'rentals');
  if (!mod?.enabled) throw new BookingError('Rentals are turned off', 400);
  const settings = mod.settings;
  const checkIn = assertDate(args.check_in, 'Check-in', settings.timezone);
  const checkOut = assertDate(args.check_out, 'Check-out', settings.timezone);
  const guests = guestsOf(args.guests);
  const who = customer(args, origin.source === 'call');
  const rental = findByName(await listRentals(workspace.id, true), text(args.apartment, 120));
  if (!rental) throw new BookingError('Unknown apartment', 400);
  if (guests > rental.max_guests) throw new BookingError(`${rental.name} fits up to ${rental.max_guests} guests`, 400);
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1 || nights > MAX_STAY_NIGHTS) throw new BookingError(`Stays are 1–${MAX_STAY_NIGHTS} nights`, 400);

  const { data, error } = await db()
    .from('va_bookings')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      kind: 'stay',
      rental_id: rental.id,
      starts_at: zonedToUtc(checkIn, settings.check_in_time, settings.timezone).toISOString(),
      ends_at: zonedToUtc(checkOut, settings.check_out_time, settings.timezone).toISOString(),
      customer_name: who.name,
      customer_phone: who.phone,
      guests,
      notes: who.notes,
      total_cents: nights * rental.nightly_price_cents,
      source: origin.source,
      retell_call_id: origin.callId ?? null,
      created_by: origin.userId ?? null,
    })
    .select('id')
    .single();
  // 23P01: the exclusion constraint caught an overlapping stay
  if (error?.code === '23P01') throw new BookingError(`${rental.name} is already booked for some of those nights`, 409);
  if (error) throw new Error(`Failed to book: ${error.message}`);
  return (await findBooking(workspace.id, data.id))!;
}

// ---------------------------------------------------------------------------
// Guest-only details (key safe codes, Wi-Fi, door codes)

const ACCESS_ATTEMPTS = 3;
const ACCESS_WINDOW_MS = 60 * 60 * 1000;
const ACCESS_EARLY_MS = 24 * 60 * 60 * 1000;

/**
 * Gives a caller their apartment's guest-only details, but only if they prove a confirmed
 * stay: the booking reference plus the phone number on it, from 24 hours before check-in
 * until check-out (the same rule as sending the code in the chat a day before arrival).
 * A few tries per call, so a caller can't guess references.
 */
type VerifiedStay = Pick<Booking, 'id' | 'reference' | 'rental_id' | 'customer_phone' | 'starts_at' | 'ends_at' | 'guests' | 'total_cents' | 'history'>;

/**
 * Finds the caller's confirmed, not yet finished stay from the booking reference (the first 8
 * characters of its id) and the mobile number on it. Returns a message instead when it can't.
 * `bucket` limits tries per call, so references can't be guessed.
 */
async function verifyStay(
  workspace: Workspace,
  args: Record<string, unknown>,
  callId: string | null,
  bucket: string,
  tries: number
): Promise<VerifiedStay | string> {
  if (!rateLimit(`${bucket}:${workspace.id}:${callId ?? 'none'}`, tries, ACCESS_WINDOW_MS).allowed) {
    return 'Too many tries on this call. Do not share codes or change anything. Tell the caller to message the host through the booking app.';
  }
  // Callers say it with spaces or dashes ("482 913"); only the digits count
  const reference = text(args.booking_reference, 20).replace(/\D/g, '');
  const phoneDigits = text(args.phone, 40).replace(/\D/g, '');
  if (reference.length !== 6 || phoneDigits.length < 7) {
    return 'Ask for the 6-digit booking reference and the mobile number used for the booking.';
  }
  const { data, error } = await db()
    .from('va_bookings')
    .select('id, reference, rental_id, customer_phone, starts_at, ends_at, guests, total_cents, history')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('reference', reference)
    .eq('kind', 'stay')
    .eq('status', 'confirmed')
    .gte('ends_at', new Date().toISOString());
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  const lastDigits = (v: string | null) => (v ?? '').replace(/\D/g, '').slice(-7);
  const booking = (data as VerifiedStay[] | null)?.find((b) => lastDigits(b.customer_phone) === phoneDigits.slice(-7));
  return booking ?? 'No confirmed upcoming stay matches that reference and mobile number. Offer to have the host contact them.';
}

/**
 * Gives a caller their apartment's guest-only details, but only for a verified stay and from 24
 * hours before check-in (the same rule as sending the code in the chat a day before arrival).
 */
async function guestAccess(workspace: Workspace, args: Record<string, unknown>, callId: string | null): Promise<string> {
  const booking = await verifyStay(workspace, args, callId, 'guest-access', ACCESS_ATTEMPTS);
  if (typeof booking === 'string') return `${booking} Do not share any codes.`;
  if (Date.now() < Date.parse(booking.starts_at) - ACCESS_EARLY_MS) {
    return 'The booking is confirmed, but access details are only shared from 24 hours before check-in. Tell the guest they will get them then.';
  }
  const { guest_info } = await getRentalPrivate(workspace, booking.rental_id!);
  if (!guest_info) return 'The booking is confirmed, but no access details are on file. Tell the guest the host will send them in the chat.';
  return `Verified guest. Share these access details with this caller only, slowly and clearly:\n${guest_info}`;
}

// ---------------------------------------------------------------------------
// Changes and cancellations by the guest, following the workspace's policy

const CHANGE_ATTEMPTS = 5;

function localDate(iso: string, timezone: string) {
  return localParts(new Date(iso), timezone).date;
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** What cancelling now would cost under the policy, or why it can't be done by phone. */
function cancellationTerms(stay: VerifiedStay, settings: RentalSettings) {
  if (Date.now() >= Date.parse(stay.starts_at)) return { allowed: false as const };
  const checkIn = localDate(stay.starts_at, settings.timezone);
  const freeUntil = addDays(checkIn, -settings.cancel_free_days);
  const free = daysBetween(todayIn(settings.timezone), checkIn) >= settings.cancel_free_days;
  const fee = free ? 0 : Math.round(((stay.total_cents ?? 0) * settings.cancel_fee_percent) / 100);
  return { allowed: true as const, free, fee, freeUntil };
}

function changeDeadline(stay: VerifiedStay, settings: RentalSettings) {
  return Date.parse(stay.starts_at) - settings.change_cutoff_hours * 3_600_000;
}

function money(cents: number, settings: RentalSettings) {
  return formatPrice(cents, settings.currency);
}

async function rentalSettings(workspace: Workspace) {
  const mod = await getModule(workspace.id, 'rentals');
  return mod?.enabled ? (mod.settings as RentalSettings) : null;
}

/** Reads back a verified stay with what the guest may change or cancel, and at what cost. */
async function describeStay(workspace: Workspace, args: Record<string, unknown>, callId: string | null) {
  const settings = await rentalSettings(workspace);
  if (!settings) return 'Rentals are turned off.';
  const stay = await verifyStay(workspace, args, callId, 'stay-verify', CHANGE_ATTEMPTS);
  if (typeof stay === 'string') return stay;
  const rental = (await listRentals(workspace.id)).find((r) => r.id === stay.rental_id);
  const checkIn = localDate(stay.starts_at, settings.timezone);
  const checkOut = localDate(stay.ends_at, settings.timezone);
  const nights = daysBetween(checkIn, checkOut);
  const started = Date.now() >= Date.parse(stay.starts_at);
  const terms = cancellationTerms(stay, settings);
  const deadline = changeDeadline(stay, settings);
  const lines = [
    `Verified stay: ${rental?.name ?? 'apartment'}${rental?.code ? ` (${rental.code})` : ''}, ${stay.guests ?? '?'} guests, check-in ${describeDate(checkIn, settings.timezone)} (${checkIn}), check-out ${describeDate(checkOut, settings.timezone)} (${checkOut}), ${nights} nights, total ${money(stay.total_cents ?? 0, settings)}.`,
    started
      ? 'The stay has started: it can be extended (later check-out) if the apartment is free; for anything else, offer to have the host call back.'
      : Date.now() < deadline
        ? `Dates, apartment and number of guests can be changed until ${new Date(deadline).toLocaleString('en-US', { timeZone: settings.timezone, dateStyle: 'medium', timeStyle: 'short' })}, if available. Extending is possible any time if the apartment is free.`
        : `Changes to dates, apartment or guests are no longer possible (less than ${settings.change_cutoff_hours} hours before check-in). Extending check-out is still possible if the apartment is free.`,
    !terms.allowed
      ? 'Cancelling is not possible once the stay has started.'
      : terms.free
        ? `Cancelling now is free (free cancellation until ${describeDate(terms.freeUntil, settings.timezone)}).`
        : `Cancelling now costs ${money(terms.fee, settings)} (${settings.cancel_fee_percent}% of the total); free cancellation ended ${describeDate(terms.freeUntil, settings.timezone)}.`,
    settings.policy_notes && `Policy notes: ${settings.policy_notes}`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function changeStay(workspace: Workspace, args: Record<string, unknown>, callId: string | null) {
  const settings = await rentalSettings(workspace);
  if (!settings) return 'Rentals are turned off.';
  const stay = await verifyStay(workspace, args, callId, 'stay-verify', CHANGE_ATTEMPTS);
  if (typeof stay === 'string') return stay;
  const rentals = await listRentals(workspace.id);
  const current = rentals.find((r) => r.id === stay.rental_id)!;
  const oldIn = localDate(stay.starts_at, settings.timezone);
  const oldOut = localDate(stay.ends_at, settings.timezone);
  const newIn = text(args.check_in, 10) || oldIn;
  const newOut = text(args.check_out, 10) || oldOut;
  const target = args.apartment ? findByName(rentals.filter((r) => r.active), text(args.apartment, 120)) : current;
  if (!target) return `There's no apartment called "${text(args.apartment, 120)}". Call get_apartments for the list.`;
  const guests = args.guests === undefined || args.guests === null || args.guests === '' ? (stay.guests ?? 1) : guestsOf(args.guests);
  if (newIn === oldIn && newOut === oldOut && target.id === current.id && guests === stay.guests) return 'Nothing to change.';

  const extension = target.id === current.id && newIn === oldIn && newOut > oldOut && guests === stay.guests;
  const started = Date.now() >= Date.parse(stay.starts_at);
  if (started && !extension) return 'The stay has started, so only extending check-out can be done by phone. Offer to have the host call back.';
  if (!started && !extension && Date.now() >= changeDeadline(stay, settings)) {
    return `Changes are only possible until ${settings.change_cutoff_hours} hours before check-in. Only extending check-out is still possible. Offer to have the host call back.`;
  }
  if (newIn !== oldIn) assertDate(newIn, 'Check-in', settings.timezone);
  assertDate(newOut, 'Check-out', settings.timezone);
  const nights = daysBetween(newIn, newOut);
  if (nights < 1 || nights > MAX_STAY_NIGHTS) return `Stays are 1–${MAX_STAY_NIGHTS} nights.`;
  if (guests > target.max_guests) return `${target.name} fits up to ${target.max_guests} guests.`;

  const startsAt = zonedToUtc(newIn, settings.check_in_time, settings.timezone).toISOString();
  const endsAt = zonedToUtc(newOut, settings.check_out_time, settings.timezone).toISOString();
  const { data: clash, error: clashErr } = await db()
    .from('va_bookings')
    .select('id')
    .eq('workspace_id', workspace.id)
    .eq('rental_id', target.id)
    .eq('kind', 'stay')
    .eq('status', 'confirmed')
    .neq('id', stay.id)
    .lt('starts_at', endsAt)
    .gt('ends_at', startsAt)
    .limit(1);
  if (clashErr) throw new Error(`Failed to check availability: ${clashErr.message}`);
  if (clash.length) return `${target.name} isn’t free for those dates. Suggest other dates or another apartment (check with check_stay_availability).`;

  const total = nights * target.nightly_price_cents;
  const what = [
    target.id !== current.id && `apartment ${current.name} → ${target.name}`,
    (newIn !== oldIn || newOut !== oldOut) && `dates ${oldIn}–${oldOut} → ${newIn}–${newOut}`,
    guests !== stay.guests && `guests ${stay.guests} → ${guests}`,
  ]
    .filter(Boolean)
    .join(', ');
  const now = new Date().toISOString();
  const { error } = await db()
    .from('va_bookings')
    .update({
      rental_id: target.id,
      starts_at: startsAt,
      ends_at: endsAt,
      guests,
      total_cents: total,
      updated_at: now,
      history: [...(stay.history ?? []), { at: now, by: 'call', action: 'changed', summary: `Changed by the guest: ${what}` }],
    })
    .eq('workspace_id', workspace.id)
    .eq('id', stay.id)
    .eq('status', 'confirmed');
  if (error?.code === '23P01') return `${target.name} was just booked for some of those nights. Suggest other dates.`;
  if (error) throw new Error(`Failed to change the booking: ${error.message}`);
  const diff = total - (stay.total_cents ?? 0);
  return `Updated: ${target.name}, ${guests} guests, check-in ${describeDate(newIn, settings.timezone)}, check-out ${describeDate(newOut, settings.timezone)}, ${nights} nights. New total ${money(total, settings)} (was ${money(stay.total_cents ?? 0, settings)}; ${diff >= 0 ? `${money(diff, settings)} more` : `${money(-diff, settings)} less`}). The booking reference stays the same.`;
}

async function cancelStay(workspace: Workspace, args: Record<string, unknown>, callId: string | null) {
  const settings = await rentalSettings(workspace);
  if (!settings) return 'Rentals are turned off.';
  const stay = await verifyStay(workspace, args, callId, 'stay-verify', CHANGE_ATTEMPTS);
  if (typeof stay === 'string') return stay;
  const terms = cancellationTerms(stay, settings);
  if (!terms.allowed) return 'The stay has started, so it can’t be cancelled by phone. Offer to have the host call back.';
  const now = new Date().toISOString();
  const summary = terms.free ? 'Cancelled by the guest (free cancellation)' : `Cancelled by the guest: fee ${money(terms.fee, settings)} (${settings.cancel_fee_percent}%)`;
  const { data, error } = await db()
    .from('va_bookings')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      cancellation_fee_cents: terms.fee,
      updated_at: now,
      history: [...(stay.history ?? []), { at: now, by: 'call', action: 'cancelled', summary }],
    })
    .eq('workspace_id', workspace.id)
    .eq('id', stay.id)
    .eq('status', 'confirmed')
    .select('id');
  if (error) throw new Error(`Failed to cancel: ${error.message}`);
  if (!data.length) return 'That booking was already cancelled.';
  return terms.free
    ? 'Cancelled, free of charge. Tell the guest any payment is refunded through the platform they paid with.'
    : `Cancelled. Under the cancellation policy a fee of ${money(terms.fee, settings)} (${settings.cancel_fee_percent}% of the total) applies; the host will settle the rest of the refund.`;
}

// ---------------------------------------------------------------------------
// Agent functions (/api/agent-tools): plain-language results for the agent to speak from

function describeDate(date: string, timezone: string) {
  return new Date(zonedToUtc(date, '12:00', timezone)).toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** "482913" -> "482 913", which the agent reads digit by digit. */
function spokenReference(reference: string) {
  return `${reference.slice(0, 3)} ${reference.slice(3)}`;
}

function time12(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Runs one agent function and returns what the agent should know. Errors become instructions, not failures. */
export async function runAgentTool(workspace: Workspace, name: string, args: Record<string, unknown>, callId: string | null) {
  try {
    switch (name) {
      case 'get_services': {
        const mod = await getModule(workspace.id, 'reservations');
        const services = await listServices(workspace.id, true);
        if (!mod?.enabled || !services.length) return 'No services are set up. Take the caller’s details and say the team will call back.';
        return services
          .map(
            (s) =>
              `- ${s.name}: ${s.duration_minutes} minutes${s.price_cents ? `, ${formatPrice(s.price_cents, mod.settings.currency)}` : ''}${s.description ? `. ${s.description}` : ''}`
          )
          .join('\n');
      }
      case 'check_availability': {
        const mod = await getModule(workspace.id, 'reservations');
        if (!mod?.enabled) return 'Reservations are turned off.';
        const service = findByName(await listServices(workspace.id, true), text(args.service, 120));
        if (!service) return `There's no service called "${text(args.service, 120)}". Call get_services for the list.`;
        const date = assertDate(args.date, 'The date', mod.settings.timezone);
        const slots = await appointmentSlots(workspace.id, mod.settings, service, date);
        if (slots.length) {
          return `${service.name} on ${describeDate(date, mod.settings.timezone)} (${date}). Free start times: ${slots.map(time12).join(', ')}.`;
        }
        // Help the agent offer something: the next days with openings
        const next: string[] = [];
        for (let i = 1; i <= 14 && next.length < 3; i++) {
          const day = addDays(date, i);
          const free = await appointmentSlots(workspace.id, mod.settings, service, day);
          if (free.length) next.push(`${describeDate(day, mod.settings.timezone)} (${day}) from ${time12(free[0])}`);
        }
        return `No free times for ${service.name} on ${describeDate(date, mod.settings.timezone)}.${next.length ? ` Next openings: ${next.join('; ')}.` : ''}`;
      }
      case 'book_appointment': {
        const booking = await bookAppointment(workspace, args, { source: 'call', callId });
        const mod = await getModule(workspace.id, 'reservations');
        const local = localParts(new Date(booking.starts_at), mod!.settings.timezone);
        return `Booked: ${booking.item_name} for ${booking.customer_name} on ${describeDate(local.date, mod!.settings.timezone)} at ${time12(local.time)}. Booking reference ${spokenReference(booking.reference)}.`;
      }
      case 'get_apartments': {
        const mod = await getModule(workspace.id, 'rentals');
        const rentals = await listRentals(workspace.id, true);
        if (!mod?.enabled || !rentals.length) return 'No apartments are set up. Take the caller’s details and say the host will call back.';
        const head = `Check-in from ${time12(mod.settings.check_in_time)}, check-out by ${time12(mod.settings.check_out_time)}.`;
        // Many apartments: a short line each (Retell caps function results); details come one at a time
        const brief = rentals.length > 6;
        return [
          head,
          ...rentals.map((r) =>
            [
              `- ${r.name}${r.code ? ` (${r.code})` : ''}: ${formatPrice(r.nightly_price_cents, mod.settings.currency)} per night, up to ${r.max_guests} guests`,
              r.bedrooms !== null ? `, ${r.bedrooms === 0 ? 'studio' : `${r.bedrooms} bedroom${r.bedrooms === 1 ? '' : 's'}`}` : '',
              r.address ? `. Area: ${r.address}` : '',
              !brief && r.description ? `. ${r.description}` : '',
              !brief && r.amenities ? `. Amenities: ${r.amenities}` : '',
              !brief && r.rules ? `. House rules: ${r.rules}` : '',
            ].join('')
          ),
          ...(brief ? ['For amenities, house rules, parking or directions, call get_apartment_details for one apartment.'] : []),
        ].join('\n');
      }
      case 'get_apartment_details': {
        const mod = await getModule(workspace.id, 'rentals');
        const rental = findByName(await listRentals(workspace.id, true), text(args.apartment, 120));
        if (!mod?.enabled || !rental) return `There's no apartment called "${text(args.apartment, 120)}". Call get_apartments for the list.`;
        return [
          `${rental.name}${rental.code ? ` (${rental.code})` : ''}: ${formatPrice(rental.nightly_price_cents, mod.settings.currency)} per night, up to ${rental.max_guests} guests.`,
          rental.address && `Area: ${rental.address}.`,
          rental.description,
          rental.amenities && `Amenities: ${rental.amenities}.`,
          rental.rules && `House rules: ${rental.rules}`,
          rental.details,
        ]
          .filter(Boolean)
          .join('\n');
      }
      case 'get_guest_access':
        return guestAccess(workspace, args, callId);
      case 'find_booking':
        return describeStay(workspace, args, callId);
      case 'change_stay':
        return changeStay(workspace, args, callId);
      case 'cancel_stay':
        return cancelStay(workspace, args, callId);
      case 'check_stay_availability': {
        const mod = await getModule(workspace.id, 'rentals');
        if (!mod?.enabled) return 'Rentals are turned off.';
        const checkIn = assertDate(args.check_in, 'Check-in', mod.settings.timezone);
        const checkOut = assertDate(args.check_out, 'Check-out', mod.settings.timezone);
        const options = await stayOptions(workspace.id, mod.settings, {
          check_in: checkIn,
          check_out: checkOut,
          guests: guestsOf(args.guests),
          apartment: optional(args.apartment, 120),
        });
        const when = `${describeDate(checkIn, mod.settings.timezone)} to ${describeDate(checkOut, mod.settings.timezone)}`;
        if (!options.length) return `Nothing is free for ${when} for ${args.guests} guests. Suggest other dates.`;
        return `Free for ${when} (${options[0].nights} nights):\n${options
          .map((o) => `- ${o.rental.name}: ${formatPrice(o.total_cents, mod.settings.currency)} total (${formatPrice(o.rental.nightly_price_cents, mod.settings.currency)} per night)`)
          .join('\n')}`;
      }
      case 'book_stay': {
        const booking = await bookStay(workspace, args, { source: 'call', callId });
        const mod = await getModule(workspace.id, 'rentals');
        const settings = mod!.settings;
        return `Booked: ${booking.item_name} for ${booking.customer_name}, ${booking.guests} guests, check-in ${describeDate(text(args.check_in, 10), settings.timezone)} from ${time12(settings.check_in_time)}, check-out ${describeDate(text(args.check_out, 10), settings.timezone)} by ${time12(settings.check_out_time)}. Total ${formatPrice(booking.total_cents ?? 0, settings.currency)}. Booking reference ${spokenReference(booking.reference)}.`;
      }
      default:
        return `Unknown function ${name}.`;
    }
  } catch (error) {
    if (error instanceof BookingError) return `Couldn’t do that: ${error.message}. Tell the caller and offer another option.`;
    throw error;
  }
}
