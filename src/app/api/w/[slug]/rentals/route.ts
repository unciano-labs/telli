import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { BookingError, deleteItem, saveItem, validateRental } from '@/lib/bookings';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idFrom(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  return UUID.test(id) ? id : null;
}

/** Creates a apartment, or updates one with ?id=. Prices are in whole currency units. Live for calls at once. */
async function save(req: Request, { params }: Params, method: 'POST' | 'PATCH') {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = method === 'PATCH' ? idFrom(req) : null;
  if (method === 'PATCH' && !id) return NextResponse.json({ error: 'A valid id is required' }, { status: 400 });
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    const item = await saveItem(auth.workspace, 'va_rentals', id, validateRental(body));
    return NextResponse.json({ item }, { status: id ? 200 : 201 });
  } catch (error) {
    return errorResponse(error, 'w/rentals ' + method, [BookingError]);
  }
}

export const POST = (req: Request, ctx: Params) => save(req, ctx, 'POST');
export const PATCH = (req: Request, ctx: Params) => save(req, ctx, 'PATCH');

/** Deletes it, or hides it when bookings refer to it. */
export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid id is required' }, { status: 400 });
  try {
    return NextResponse.json({ result: await deleteItem(auth.workspace, 'va_rentals', id) });
  } catch (error) {
    return errorResponse(error, 'w/rentals DELETE', [BookingError]);
  }
}
