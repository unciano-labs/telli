import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { isWebsiteAdmin } from '@/lib/auth';
import { TwilioError } from '@/lib/twilio';
import {
  buyRetellNumber,
  buyTwilioNumber,
  importByoNumber,
  listNumbers,
  normalizeNickname,
  NumberError,
  validateByo,
} from '@/lib/phone-numbers';

type Params = { params: Promise<{ slug: string }> };
const APP_ERRORS = [NumberError, TwilioError];

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ numbers: await listNumbers(auth.workspace.id) });
  } catch (error) {
    return errorResponse(error, 'w/numbers GET', APP_ERRORS);
  }
}

/**
 * Body: { provider: 'retell', country, area_code?, nickname? }
 *     | { provider: 'twilio', e164, country, nickname? }
 *     | { provider: 'byo', e164, termination_uri, username?, password?, nickname?, outbound_countries[] }.
 * Buying costs us money every month, so until billing (Phase 6) only website admins can buy.
 * Workspace admins can connect their own number.
 */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  const str = (key: string) => (typeof body[key] === 'string' ? body[key].trim() : '');
  try {
    if (body.provider === 'byo') {
      const number = await importByoNumber(auth.workspace, auth.user.id, validateByo(body));
      return NextResponse.json({ number }, { status: 201 });
    }
    if (body.provider !== 'retell' && body.provider !== 'twilio') {
      return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
    }
    if (!(await isWebsiteAdmin(auth.user.id))) {
      return NextResponse.json({ error: 'Buying a number isn’t available yet. Contact us to add one.' }, { status: 403 });
    }
    const input = { country: str('country').toUpperCase(), nickname: normalizeNickname(body.nickname) };
    const number =
      body.provider === 'retell'
        ? await buyRetellNumber(auth.workspace, auth.user.id, { ...input, areaCode: str('area_code') || null })
        : await buyTwilioNumber(auth.workspace, auth.user.id, { ...input, e164: str('e164') });
    return NextResponse.json({ number }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/numbers POST', APP_ERRORS);
  }
}
