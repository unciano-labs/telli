import { NextResponse } from 'next/server';
import { settleCheckout } from '@/lib/billing';
import { verifyWebhook } from '@/lib/paymongo';
import { errorMessage } from '@/lib/retell';

/**
 * PayMongo events, signed with the webhook's secret key (PAYMONGO_WEBHOOK_SECRET, printed by
 * scripts/paymongo-webhook.mjs). Only checkout payments matter; the checkout is re-read from
 * PayMongo before a month is applied, so the payload itself is never trusted.
 */
export async function POST(req: Request) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  const body = await req.text();
  if (!verifyWebhook(body, req.headers.get('paymongo-signature'), secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: { data?: { attributes?: { type?: string; data?: { id?: string } } } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const type = event.data?.attributes?.type;
  const checkoutId = event.data?.attributes?.data?.id;
  if (type !== 'checkout_session.payment.paid' || !checkoutId) return NextResponse.json({ ok: true });

  try {
    await settleCheckout(checkoutId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // A non-2xx makes PayMongo retry
    console.error('[webhooks/paymongo]', checkoutId, errorMessage(error));
    return NextResponse.json({ error: 'Failed to process event' }, { status: 500 });
  }
}
