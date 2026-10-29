import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { bookAppointment, BookingError, bookStay, cancelBooking, listBookings } from '@/lib/bookings';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Query: ?from=ISO&to=ISO (default: from yesterday, 60 days). */
export async function GET(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  const query = new URL(req.url).searchParams;
  const from = new Date(query.get('from') ?? Date.now() - DAY_MS);
  const to = new Date(query.get('to') ?? from.getTime() + 60 * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 400 * DAY_MS) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }
  try {
    return NextResponse.json({ bookings: await listBookings(auth.workspace.id, from, to) });
  } catch (error) {
    return errorResponse(error, 'w/bookings GET', [BookingError]);
  }
}

/**
 * Body: { kind: 'appointment', service, date, time, customer_name, customer_phone?, notes? }
 *     | { kind: 'stay', apartment, check_in, check_out, guests, customer_name, customer_phone?, notes? }.
 * The team adds a booking by hand (e.g. a walk-in or a call to the front desk).
 */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  const origin = { source: 'manual' as const, userId: auth.user.id };
  try {
    const booking =
      body.kind === 'stay' ? await bookStay(auth.workspace, body, origin) : await bookAppointment(auth.workspace, body, origin);
    return NextResponse.json({ booking }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/bookings POST', [BookingError]);
  }
}

/** Query: ?id=… Cancels a booking (members can see it, admins cancel). */
export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'A valid id is required' }, { status: 400 });
  try {
    await cancelBooking(auth.workspace, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'w/bookings DELETE', [BookingError]);
  }
}
