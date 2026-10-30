import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { BookingError, getRentalPrivate, saveRentalPrivate } from '@/lib/bookings';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idFrom(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  return UUID.test(id) ? id : null;
}

/** Query: ?id=… An apartment's guest-only and team-only details (owners and admins). */
export async function GET(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid id is required' }, { status: 400 });
  try {
    return NextResponse.json({ private: await getRentalPrivate(auth.workspace, id) });
  } catch (error) {
    return errorResponse(error, 'w/rentals/private GET', [BookingError]);
  }
}

/** Query: ?id=… Body: { guest_info, internal_notes }. */
export async function PUT(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid id is required' }, { status: 400 });
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    return NextResponse.json({ private: await saveRentalPrivate(auth.workspace, id, body) });
  } catch (error) {
    return errorResponse(error, 'w/rentals/private PUT', [BookingError]);
  }
}
