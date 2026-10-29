// Registers the PayMongo webhook for this deployment (run once per environment).
//
// Usage (from the project root):
//   node scripts/paymongo-webhook.mjs https://your-app.example.com
//
// Prints the webhook's secret key: set it as PAYMONGO_WEBHOOK_SECRET. PayMongo only shows it
// once. Payments still go through without the webhook: the Billing page checks pending
// payments with PayMongo when it loads.

import { env } from './lib/harness.mjs';

const base = (process.argv[2] || env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Pass the public https address of the app, e.g. https://voice.example.com');
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${env.PAYMONGO_SECRET_KEY}:`).toString('base64')}`;
const url = `${base}/api/webhooks/paymongo`;

const existing = await fetch('https://api.paymongo.com/v1/webhooks', { headers: { Authorization: auth } }).then((r) => r.json());
if (existing.data?.some((w) => w.attributes.url === url)) {
  console.log(`A webhook for ${url} already exists. Delete it in PayMongo to get a new secret.`);
  process.exit(0);
}
const res = await fetch('https://api.paymongo.com/v1/webhooks', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: { attributes: { url, events: ['checkout_session.payment.paid'] } } }),
});
const body = await res.json();
if (!res.ok) {
  console.error('PayMongo refused:', JSON.stringify(body.errors ?? body));
  process.exit(1);
}
console.log(`Webhook registered for ${url}`);
console.log(`PAYMONGO_WEBHOOK_SECRET=${body.data.attributes.secret_key}`);
