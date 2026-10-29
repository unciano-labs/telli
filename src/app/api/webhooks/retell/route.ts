import { NextResponse } from 'next/server';
import { verify } from 'retell-sdk';
import type { CallResponse } from 'retell-sdk/resources/call';
import { applyRetellCall } from '@/lib/call-logs';
import { errorMessage } from '@/lib/retell';

const HANDLED_EVENTS = new Set(['call_started', 'call_ended', 'call_analyzed']);

/**
 * Retell call events. Signed with the account's webhook API key; the signature
 * includes a timestamp, so replayed requests are rejected by verify().
 */
export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get('x-retell-signature');
  const apiKey = (process.env.RETELL_WEBHOOK_KEY || process.env.RETELL_API_KEY)?.trim();

  if (!signature || !apiKey || !(await verify(body, apiKey, signature).catch(() => false))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { event?: string; call?: CallResponse };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { event, call } = payload;
  if (!event || !HANDLED_EVENTS.has(event) || !call?.call_id) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    await applyRetellCall(call);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // 500 makes Retell retry the delivery
    console.error('[webhooks/retell]', event, call.call_id, errorMessage(error));
    return NextResponse.json({ error: 'Failed to process event' }, { status: 500 });
  }
}
