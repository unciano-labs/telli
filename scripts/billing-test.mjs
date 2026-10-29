// Plans and billing test (Phase 6).
//
// A throwaway workspace goes from trial to paid: trial limits, a PayMongo checkout paid in
// test mode (the hosted page is driven with Playwright: GCash → "Authorize Test Payment"),
// the month applied on return, an early renewal that starts when the month ends, an upgrade
// that starts now and unlocks outbound calls, calls stopped when the minutes run out and
// when the month ends, a month granted by platform staff, and the revenue report.
//
// Usage (from the project root, app running, PAYMONGO_SECRET_KEY = sk_test_…):
//   node scripts/billing-test.mjs [appUrl]
//
// Needs Playwright with Chromium: `npm i -D playwright && npx playwright install chromium`,
// or point PLAYWRIGHT_MODULE at an installed copy's index.mjs.

import { APP, admin, check, cleanup, env, makeUser, RUN, tally } from './lib/harness.mjs';

if (!env.PAYMONGO_SECRET_KEY?.startsWith('sk_test_')) {
  console.error('Refusing to run: PAYMONGO_SECRET_KEY must be a test key (sk_test_…).');
  process.exit(1);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const fakeNumber = `+1${201 + (parseInt(RUN.slice(-5), 36) % 600)}5550${100 + (parseInt(RUN.slice(-3), 36) % 100)}`.slice(0, 12);

/** Pays a PayMongo test checkout with GCash, the way a customer would. */
async function payInTestMode(checkoutUrl) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(checkoutUrl, { waitUntil: 'networkidle' });
    await page.getByText('E-Wallets', { exact: true }).click();
    await page.getByText('GCash', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.fill('input[name=name]', 'Test Buyer');
    await page.fill('input[name=email]', 'buyer@example.com');
    await page.getByRole('button', { name: /^Pay / }).click();
    await page.getByRole('button', { name: 'Authorize Test Payment' }).click();
    await page.getByText('Payment Received', { exact: false }).waitFor({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
}

/** Starts a checkout for a plan, pays it, then comes back to the Billing page (which applies it). */
async function buy(owner, slug, plan) {
  const res = await owner.api('POST', `/api/w/${slug}/billing`, { plan });
  if (res.status !== 200) throw new Error(`checkout for ${plan} failed: ${res.status} ${res.json?.error}`);
  const payment = (await admin.from('va_payments').select('*').eq('checkout_url', res.json.url).single()).data;
  await payInTestMode(res.json.url);
  const page = await owner.api('GET', `/w/${slug}/billing?payment=${payment.id}`);
  return { url: res.json.url, page, payment: (await admin.from('va_payments').select('*').eq('id', payment.id).single()).data };
}

const users = [];
const slugs = [];
try {
  console.log(`Setting up users and a workspace on ${APP}…`);
  const owner = await makeUser('billing-owner');
  const member = await makeUser('billing-member');
  const outsider = await makeUser('billing-outsider');
  const staff = await makeUser('billing-staff', { role: 'admin' });
  users.push(owner, member, outsider, staff);
  const created = await owner.api('POST', '/api/workspaces', { name: `Billing Test ${RUN}`, template: 'support' });
  if (created.status !== 201) throw new Error(`workspace create failed: ${JSON.stringify(created.json)}`);
  const ws = created.json.workspace;
  slugs.push(ws.slug);
  const api = (who, method, path, body) => who.api(method, `/api/w/${ws.slug}${path}`, body);
  const invite = await api(owner, 'POST', '/invites', { email: member.email, role: 'member' });
  await member.api('POST', '/api/invites/accept', { token: invite.json.path.split('/').pop() });
  const workspaceRow = async () => (await admin.from('va_workspaces').select('*').eq('id', ws.id).single()).data;

  console.log('\nTrial limits');
  check('first widget is fine', (await api(owner, 'POST', '/widgets', { name: 'One' })).status === 201);
  let res = await api(owner, 'POST', '/widgets', { name: 'Two' });
  check('a second widget needs a plan', res.status === 403 && /free trial includes 1 widget/i.test(res.json?.error), `got ${res.status} ${res.json?.error}`);
  res = await api(owner, 'POST', '/numbers', { provider: 'byo', e164: fakeNumber, termination_uri: 'trunk-test.example.com' });
  check('one phone number on the trial', res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
  res = await api(owner, 'POST', '/calls', { toNumber: '+15551234567', reason: 'test' });
  check('no outbound calls on the trial', res.status === 403 && /Growth and Business/.test(res.json?.error), `got ${res.status} ${res.json?.error}`);

  console.log('\nWho can pay');
  check('members can’t start a payment', (await api(member, 'POST', '/billing', { plan: 'starter' })).status === 403);
  check('outsiders get 404', (await api(outsider, 'POST', '/billing', { plan: 'starter' })).status === 404);
  // The redirect is streamed (status 200), so check nothing about plans or payments is in the page
  const memberPage = await member.api('GET', `/w/${ws.slug}/billing`);
  check('members are sent away from Billing', /NEXT_REDIRECT[^"]*\/test/.test(memberPage.text) && !/\$39/.test(memberPage.text));
  let page = await owner.api('GET', `/w/${ws.slug}/billing`);
  check('owner sees the trial and the plans in USD', page.status === 200 && /Free trial/.test(page.text) && /Starter/.test(page.text) && /\$39/.test(page.text));
  check('no peso hint outside the Philippines', !/≈ ₱/.test(page.text));
  page = await owner.api('GET', `/w/${ws.slug}/billing`, undefined, { 'x-vercel-ip-country': 'PH' });
  check('visitors from the Philippines also see pesos', /≈ (<!-- -->)?₱[\d,]+/.test(page.text));
  check('an unknown plan is rejected', (await api(owner, 'POST', '/billing', { plan: 'gold' })).status === 400);

  console.log('\nPay for Starter (PayMongo test mode)');
  const first = await buy(owner, ws.slug, 'starter');
  check('checkout is PayMongo’s hosted page', first.url.startsWith('https://checkout.paymongo.com/'));
  check('priced in USD: the plan only (own numbers are free)', first.payment.amount_cents === 3900 && first.payment.currency === 'USD' && first.payment.line_items.length === 1);
  const rate = Number(first.payment.exchange_rate);
  check('charged in pesos at the day’s rate', rate > 50 && rate < 80 && first.payment.charged_amount_cents === Math.round((3900 * rate) / 100) * 100,
    `${first.payment.charged_amount_cents} at ${rate}`);
  check('payment applied on return', first.payment.status === 'paid' && first.payment.payment_method === 'gcash', `${first.payment.status} ${first.payment.payment_method}`);
  check('Billing page says so', /Payment received/.test(first.page.text));
  let row = await workspaceRow();
  const monthMs = new Date(first.payment.period_end) - new Date(first.payment.period_start);
  check('workspace is active on Starter for a month', row.status === 'active' && row.plan === 'starter' && monthMs > 27 * 864e5 && monthMs < 32 * 864e5);
  check('no trial banner any more', !/Free trial:/.test((await owner.api('GET', `/w/${ws.slug}/team`)).text));
  res = await api(owner, 'POST', '/widgets', { name: 'Two' });
  check('Starter still has one widget', res.status === 403 && /Starter plan includes 1 widget/.test(res.json?.error), res.json?.error);
  check('Starter has no outbound calls', (await api(owner, 'POST', '/calls', { toNumber: '+15551234567', reason: 'test' })).status === 403);

  console.log('\nRenew early, then upgrade');
  const renewal = await buy(owner, ws.slug, 'starter');
  check('an early renewal starts when this month ends', renewal.payment.period_start === first.payment.period_end, `${renewal.payment.period_start} vs ${first.payment.period_end}`);
  row = await workspaceRow();
  check('paid through two months', new Date(row.current_period_end).getTime() === new Date(renewal.payment.period_end).getTime());
  check('Billing page shows the next month is paid', /Next month is paid/.test(renewal.page.text));

  const upgrade = await buy(owner, ws.slug, 'growth');
  check('an upgrade starts today', Math.abs(new Date(upgrade.payment.period_start) - Date.now()) < 5 * 60_000);
  check('now on Growth', (await workspaceRow()).plan === 'growth');
  check('Growth allows a second widget', (await api(owner, 'POST', '/widgets', { name: 'Two' })).status === 201);
  res = await api(owner, 'POST', '/calls', { toNumber: '+15551234567', reason: 'test' });
  check('Growth allows outbound (now it only needs a caller ID)', res.status === 400 && /caller ID/.test(res.json?.error), `got ${res.status} ${res.json?.error}`);

  console.log('\nLimits on calls');
  const { data: bigCall } = await admin
    .from('va_call_logs')
    .insert({ website_id: env.WEBSITE_ID, workspace_id: ws.id, retell_call_id: `call_fake_${RUN}`, direction: 'web', source: 'widget', status: 'ended', duration_ms: 301 * 60_000 })
    .select('id')
    .single();
  res = await api(owner, 'POST', '/test-call');
  check('calls stop when the month’s minutes are used', res.status === 403 && /minutes are used up/.test(res.json?.error), `got ${res.status} ${res.json?.error}`);
  check('the banner says calls are paused', /minutes are used up, so calls are paused/.test((await owner.api('GET', `/w/${ws.slug}/team`)).text));
  await admin.from('va_call_logs').delete().eq('id', bigCall.id);

  await admin.from('va_payments').update({ period_start: '2026-01-01T00:00:00Z', period_end: '2026-02-01T00:00:00Z' }).eq('workspace_id', ws.id);
  await admin.from('va_workspaces').update({ current_period_end: '2026-02-01T00:00:00Z' }).eq('id', ws.id);
  res = await api(owner, 'POST', '/test-call');
  check('calls stop when the paid month ends', res.status === 403 && /paid month has ended/.test(res.json?.error), `got ${res.status} ${res.json?.error}`);
  check('Billing page offers to renew', /Paid month ended/.test((await owner.api('GET', `/w/${ws.slug}/billing`)).text));

  console.log('\nPlatform staff');
  check('owners can’t grant themselves a month', (await owner.api('PATCH', `/api/platform/workspaces/${ws.id}`, { grant_plan: 'business' })).status === 403);
  res = await staff.api('PATCH', `/api/platform/workspaces/${ws.id}`, { grant_plan: 'business' });
  check('staff grant a month of Business', res.status === 200 && res.json.workspace.plan === 'business', `got ${res.status} ${res.json?.error ?? ''}`);
  page = await owner.api('GET', `/w/${ws.slug}/billing`);
  check('the workspace is active again', /Business plan/.test(page.text) && !/Paid month ended/.test(page.text));
  const revenue = await staff.api('GET', '/platform/revenue');
  check('revenue report lists the workspace with $177 paid', revenue.status === 200 && revenue.text.includes(`Billing Test ${RUN}`) && /\$177/.test(revenue.text));
  check('owners can’t see the revenue report', (await owner.api('GET', '/platform/revenue')).status !== 200);

  res = await fetch(`${APP}/api/webhooks/paymongo`, { method: 'POST', body: '{"data":{}}', headers: { 'Paymongo-Signature': 't=1,te=00' } });
  check('unsigned PayMongo webhooks are refused', res.status === 401 || res.status === 503, `got ${res.status}`);
  check('outsiders read no payments directly (RLS)', ((await outsider.db.from('va_payments').select('id').eq('workspace_id', ws.id)).data ?? []).length === 0);
  check('members read no payments directly (owners only)', ((await member.db.from('va_payments').select('id').eq('workspace_id', ws.id)).data ?? []).length === 0);
  check('the owner does', ((await owner.db.from('va_payments').select('id').eq('workspace_id', ws.id)).data ?? []).length === 4);
} catch (error) {
  tally.failures++;
  console.error('\nTest run failed:', error.message);
} finally {
  await cleanup(users, slugs);
}

console.log(`\n${tally.failures ? `✗ ${tally.failures} problem(s)` : '✓ All'} · ${tally.checks} checks run.`);
process.exit(tally.failures ? 1 : 0);
