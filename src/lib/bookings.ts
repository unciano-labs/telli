import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { saveDraft } from '@/lib/agent-draft';
import { getModuleStates } from '@/lib/modules-agent';
import { formatPrice } from '@/lib/money';
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
  description: string | null;
  address: string | null;
  nightly_price_cents: number;
  max_guests: number;
  bedrooms: number | null;
  amenities: string | null;
  rules: string | null;
  active: boolean;
  sort: number;
};

export type Booking = {
  id: string;
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
  created_at: string;
};

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
  if (!(CURRENCIES as readonly string[]).includes(currency)) throw new BookingError('Choose USD or PHP', 400);

  if (module === 'rentals') {
    const cur = current as RentalSettings;
    const checkIn = (raw.check_in_time ?? cur.check_in_time) as string;
    const checkOut = (raw.check_out_time ?? cur.check_out_time) as string;
    if (!HHMM.test(checkIn) || !HHMM.test(checkOut)) throw new BookingError('Check-in and check-out times are HH:MM', 400);
    return { timezone, currency, check_in_time: checkIn, check_out_time: checkOut } satisfies RentalSettings;
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
    .select('id, name, description, address, nightly_price_cents, max_guests, bedrooms, amenities, rules, active, sort')
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
    active: body.active !== false,
  };
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
  'id, kind, service_id, rental_id, starts_at, ends_at, customer_name, customer_phone, guests, notes, total_cents, status, source, created_at, va_services(name), va_rentals(name)';

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
  const { data, error } = await db()
    .from('va_bookings')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .eq('status', 'confirmed')
    .select('id');
  if (error) throw new Error(`Failed to cancel: ${error.message}`);
  if (!data.length) throw new BookingError('Booking not found or already cancelled', 404);
}

function findByName<T extends { name: string }>(items: T[], name: string): T | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return (
    items.find((i) => i.name.toLowerCase() === wanted) ??
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
// Agent functions (/api/agent-tools): plain-language results for the agent to speak from

function describeDate(date: string, timezone: string) {
  return new Date(zonedToUtc(date, '12:00', timezone)).toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
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
        return `Booked: ${booking.item_name} for ${booking.customer_name} on ${describeDate(local.date, mod!.settings.timezone)} at ${time12(local.time)}. Reference ${booking.id.slice(0, 8).toUpperCase()}.`;
      }
      case 'get_apartments': {
        const mod = await getModule(workspace.id, 'rentals');
        const rentals = await listRentals(workspace.id, true);
        if (!mod?.enabled || !rentals.length) return 'No apartments are set up. Take the caller’s details and say the host will call back.';
        const head = `Check-in from ${time12(mod.settings.check_in_time)}, check-out by ${time12(mod.settings.check_out_time)}.`;
        return [
          head,
          ...rentals.map((r) =>
            [
              `- ${r.name}: ${formatPrice(r.nightly_price_cents, mod.settings.currency)} per night, up to ${r.max_guests} guests`,
              r.bedrooms !== null ? `, ${r.bedrooms === 0 ? 'studio' : `${r.bedrooms} bedroom${r.bedrooms === 1 ? '' : 's'}`}` : '',
              r.address ? `. Address: ${r.address}` : '',
              r.description ? `. ${r.description}` : '',
              r.amenities ? `. Amenities: ${r.amenities}` : '',
              r.rules ? `. House rules: ${r.rules}` : '',
            ].join('')
          ),
        ].join('\n');
      }
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
        return `Booked: ${booking.item_name} for ${booking.customer_name}, ${booking.guests} guests, check-in ${describeDate(text(args.check_in, 10), settings.timezone)} from ${time12(settings.check_in_time)}, check-out ${describeDate(text(args.check_out, 10), settings.timezone)} by ${time12(settings.check_out_time)}. Total ${formatPrice(booking.total_cents ?? 0, settings.currency)}. Reference ${booking.id.slice(0, 8).toUpperCase()}.`;
      }
      default:
        return `Unknown function ${name}.`;
    }
  } catch (error) {
    if (error instanceof BookingError) return `Couldn’t do that: ${error.message}. Tell the caller and offer another option.`;
    throw error;
  }
}
