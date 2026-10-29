import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// PayMongo Checkout Sessions: a hosted page that takes GCash, Maya, cards and QR Ph.
// Each payment is one session; we never see card details.

const API = 'https://api.paymongo.com/v1';
const PAYMENT_METHODS = ['gcash', 'paymaya', 'card', 'grab_pay', 'qrph'];
const WEBHOOK_TOLERANCE_S = 5 * 60;

export class PayMongoError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function secretKey() {
  const key = process.env.PAYMONGO_SECRET_KEY?.trim();
  if (!key) throw new PayMongoError('Payments aren’t set up yet', 503);
  return key;
}

export function paymongoConfigured() {
  return Boolean(process.env.PAYMONGO_SECRET_KEY?.trim());
}

/** sk_test_ keys take test payments only. */
export function paymongoTestMode() {
  return process.env.PAYMONGO_SECRET_KEY?.trim().startsWith('sk_test_') ?? false;
}

async function request<T>(method: 'GET' | 'POST', path: string, attributes?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey()}:`).toString('base64')}`,
      ...(attributes && { 'Content-Type': 'application/json' }),
    },
    body: attributes ? JSON.stringify({ data: { attributes } }) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.errors?.[0]?.detail ?? `request failed (${res.status})`;
    throw new PayMongoError(`PayMongo: ${detail}`, res.status === 404 ? 404 : 502);
  }
  return body.data as T;
}

type CheckoutData = {
  id: string;
  attributes: {
    checkout_url: string;
    status: 'active' | 'expired' | string;
    payment_method_used: string | null;
    payments: { id: string; attributes: { status: string } }[];
  };
};

export type Checkout = {
  id: string;
  url: string;
  status: string;
  /** The successful payment, once the customer has paid. */
  paidPaymentId: string | null;
  method: string | null;
};

function toCheckout(data: CheckoutData): Checkout {
  const paid = data.attributes.payments?.find((p) => p.attributes.status === 'paid');
  return {
    id: data.id,
    url: data.attributes.checkout_url,
    status: data.attributes.status,
    paidPaymentId: paid?.id ?? null,
    method: data.attributes.payment_method_used ?? null,
  };
}

export async function createCheckout(input: {
  lineItems: { name: string; amount_cents: number }[];
  description: string;
  reference: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<Checkout> {
  const data = await request<CheckoutData>('POST', '/checkout_sessions', {
    line_items: input.lineItems.map((item) => ({ name: item.name, amount: item.amount_cents, currency: 'PHP', quantity: 1 })),
    payment_method_types: PAYMENT_METHODS,
    description: input.description,
    reference_number: input.reference,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: input.metadata,
    show_line_items: true,
    send_email_receipt: true,
  });
  return toCheckout(data);
}

export async function getCheckout(id: string): Promise<Checkout> {
  return toCheckout(await request<CheckoutData>('GET', `/checkout_sessions/${encodeURIComponent(id)}`));
}

export async function expireCheckout(id: string): Promise<void> {
  await request('POST', `/checkout_sessions/${encodeURIComponent(id)}/expire`).catch(() => {});
}

/**
 * Checks a PayMongo webhook. The Paymongo-Signature header is "t=<unix>,te=<test sig>,li=<live sig>",
 * where each signature is HMAC-SHA256 of "<t>.<raw body>" with the webhook's secret key.
 */
export function verifyWebhook(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return false;
  const signature = paymongoTestMode() ? parts.te : parts.li;
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
