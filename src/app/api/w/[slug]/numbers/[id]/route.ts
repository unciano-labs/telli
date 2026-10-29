import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { TwilioError } from '@/lib/twilio';
import { normalizeNickname, NumberError, releasePhoneNumber, updateNumber } from '@/lib/phone-numbers';

type Params = { params: Promise<{ slug: string; id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body: { inbound_enabled?, outbound_enabled?, nickname? }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Phone number not found' }, { status: 404 });
  const body = (await req.json().catch(() => null)) ?? {};
  const patch = {
    ...(typeof body.inbound_enabled === 'boolean' && { inbound_enabled: body.inbound_enabled }),
    ...(typeof body.outbound_enabled === 'boolean' && { outbound_enabled: body.outbound_enabled }),
    ...('nickname' in body && { nickname: normalizeNickname(body.nickname) }),
  };
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  try {
    return NextResponse.json({ number: await updateNumber(auth.workspace, id, patch) });
  } catch (error) {
    return errorResponse(error, 'w/numbers PATCH', [NumberError, TwilioError]);
  }
}

/** Releases the number (owners): it stops answering, and numbers we bought stop being billed. */
export async function DELETE(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'owner');
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Phone number not found' }, { status: 404 });
  try {
    await releasePhoneNumber(auth.workspace, auth.user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'w/numbers DELETE', [NumberError, TwilioError]);
  }
}
