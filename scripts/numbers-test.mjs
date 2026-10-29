// Phone numbers test (Phase 5).
//
// A throwaway workspace gets numbers three ways: a real US number bought through Retell
// (by a website admin; about $2 a month, released at the end), and customer SIP numbers
// that are imported but don't exist (no cost). Checks who may buy, Retell's inbound binding
// to the published agent, the inbound/outbound switches, the caller ID rules, the per-
// workspace limit, and release. Every number is released, even when a check fails.
//
// Usage (from the project root, app running):
//   node scripts/numbers-test.mjs [appUrl]     # default http://localhost:3000
//
// No calls are placed: the outbound check stops at our country rule, before Retell dials.

import { APP, admin, check, cleanup, grantPlan, makeUser, retell, RUN, tally } from './lib/harness.mjs';

// 555-0100–0199 is reserved for fiction in every US area code, so these never reach a real line.
// The area code varies per run: Retell refuses to re-import a number deleted shortly before.
const AREA = 201 + (parseInt(RUN.slice(-5), 36) % 700);
const fakeNumber = (n) => `+1${String(AREA).replace(/^(\d)9/, '$18')}5550${100 + ((parseInt(RUN.slice(-3), 36) + n) % 100)}`.slice(0, 12);

async function retellNumber(e164) {
  return retell.phoneNumber.retrieve(e164).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
}

const users = [];
const slugs = [];
try {
  console.log(`Setting up users and a workspace on ${APP}…`);
  const owner = await makeUser('numbers-owner');
  const staff = await makeUser('numbers-staff', { role: 'admin' });
  const member = await makeUser('numbers-member');
  const outsider = await makeUser('numbers-outsider');
  users.push(owner, staff, member, outsider);
  const created = await owner.api('POST', '/api/workspaces', { name: `Numbers Test ${RUN}`, template: 'support' });
  if (created.status !== 201) throw new Error(`workspace create failed: ${JSON.stringify(created.json)}`);
  const ws = created.json.workspace;
  slugs.push(ws.slug);
  // Business: 3 numbers and outbound calls
  await grantPlan(ws.id, 'business');
  const api = (who, method, path, body) => who.api(method, `/api/w/${ws.slug}${path}`, body);
  const invite = await api(owner, 'POST', '/invites', { email: member.email, role: 'member' });
  await member.api('POST', '/api/invites/accept', { token: invite.json.path.split('/').pop() });
  const config = (await api(owner, 'GET', '/agent')).json.config;

  console.log('\nWho can see and buy numbers');
  let res = await api(owner, 'GET', '/numbers');
  check('owner sees the (empty) list', res.status === 200 && res.json.numbers.length === 0, `got ${res.status}`);
  check('members can’t manage numbers', (await api(member, 'GET', '/numbers')).status === 403);
  check('outsiders get 404', (await api(outsider, 'GET', '/numbers')).status === 404);
  res = await api(owner, 'POST', '/numbers', { provider: 'retell', country: 'US' });
  check('a workspace owner can’t buy yet (no billing)', res.status === 403, `got ${res.status}`);
  check('nor search Twilio', (await api(owner, 'GET', '/numbers/search?country=US')).status === 403);

  console.log('\nBring your own number');
  res = await api(owner, 'POST', '/numbers', { provider: 'byo', e164: '12345', termination_uri: 'trunk.example.com' });
  check('a malformed number is rejected', res.status === 400, `got ${res.status}`);
  res = await api(owner, 'POST', '/numbers', { provider: 'byo', e164: fakeNumber(0), termination_uri: 'https://evil.example.com/x' });
  check('a termination address that isn’t a hostname is rejected', res.status === 400, `got ${res.status}`);
  res = await api(owner, 'POST', '/numbers', { provider: 'byo', e164: '+15677575800', termination_uri: 'trunk.example.com' });
  check('a number already in Voice Agent (the platform’s) can’t be taken', res.status === 409, `got ${res.status} ${res.json?.error ?? ''}`);
  res = await api(owner, 'POST', '/numbers', {
    provider: 'byo', e164: fakeNumber(0), termination_uri: 'sip:trunk-test.example.com', username: 'u', password: 'p', nickname: 'Main line',
  });
  check('owner connects a SIP number', res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
  const byo = res.json.number;
  let rn = await retellNumber(fakeNumber(0));
  check('it’s imported into Retell and answers with the published agent',
    rn?.phone_number_type === 'custom' && rn.inbound_agents?.[0]?.agent_id === config.retell_agent_id && rn.inbound_agents?.[0]?.agent_version === 'latest_published',
    JSON.stringify(rn?.inbound_agents));
  check('its outbound countries default to its own country', JSON.stringify(rn?.allowed_outbound_country_list) === '["US"]');
  const stored = (await admin.from('va_phone_numbers').select('*').eq('id', byo.id).single()).data;
  check('SIP credentials aren’t stored', !JSON.stringify(stored).includes('"p"') && !('password' in stored));

  console.log('\nBuy a US number through Retell (website admin)');
  res = await api(staff, 'POST', '/numbers', { provider: 'retell', country: 'US', area_code: '12' });
  check('a 2-digit area code is rejected', res.status === 400);
  res = await api(staff, 'POST', '/numbers', { provider: 'retell', country: 'US', nickname: 'Front desk' });
  // Without a card on Retell's account a purchase can't happen; the rest runs on the imported number
  let bought = res.json?.number ?? null;
  if (res.status === 402) {
    console.log('  ! skipped: Retell has no payment card on file (402). Using the imported number instead.');
    check('the missing card is explained', /payment card/.test(res.json?.error ?? ''), res.json?.error);
    bought = byo;
  } else {
    check('website admin buys a number', res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
    if (!bought) throw new Error('purchase failed, stopping');
    console.log(`    bought ${bought.e164}`);
    rn = await retellNumber(bought.e164);
    check('Retell has it, bound to this workspace’s agent for calls in and out',
      rn?.inbound_agents?.[0]?.agent_id === config.retell_agent_id && rn?.outbound_agents?.[0]?.agent_id === config.retell_agent_id);
    check('saved with Retell’s price', bought.provider === 'retell' && bought.monthly_price_cents === 200);
  }
  const purchased = bought.id !== byo.id;

  res = await api(owner, 'PATCH', `/numbers/${bought.id}`, { inbound_enabled: false });
  rn = await retellNumber(bought.e164);
  check('turning inbound off unbinds the agent', res.status === 200 && !rn?.inbound_agents?.length, JSON.stringify(rn?.inbound_agents));
  res = await api(owner, 'PATCH', `/numbers/${bought.id}`, { inbound_enabled: true });
  rn = await retellNumber(bought.e164);
  check('turning it back on binds it again', rn?.inbound_agents?.[0]?.agent_id === config.retell_agent_id);

  console.log('\nOutbound caller ID');
  res = await api(owner, 'PATCH', '/outbound', { retell_phone_number: '+15677575800', outbound_begin_message: 'Hi {{customer_name}}!' });
  check('another workspace’s number can’t be the caller ID', res.status === 400, `got ${res.status}`);
  res = await api(owner, 'PATCH', '/outbound', { retell_phone_number: bought.e164, outbound_begin_message: 'Hi {{customer_name}}!' });
  check('the workspace’s number becomes the caller ID', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  res = await api(owner, 'POST', '/calls', { toNumber: '+639171234567', reason: 'test' });
  check('a number without PH in its countries can’t call the Philippines', res.status === 400 && /Philippine/.test(res.json?.error ?? ''), `got ${res.status} ${res.json?.error ?? ''}`);
  const outboundPage = await owner.api('GET', `/w/${ws.slug}/outbound`);
  check('Outbound page offers the caller ID', outboundPage.status === 200 && outboundPage.text.includes(bought.e164.slice(2)));
  await api(owner, 'PATCH', `/numbers/${bought.id}`, { outbound_enabled: false });
  check('turning outbound off clears the caller ID', (await api(owner, 'GET', '/agent')).json.config.retell_phone_number === null);
  await api(owner, 'PATCH', `/numbers/${bought.id}`, { outbound_enabled: true });

  console.log('\nLimits and visibility');
  // Fill up to the limit with imported numbers
  const have = purchased ? 2 : 1;
  for (let i = have; i < 3; i++) {
    res = await api(owner, 'POST', '/numbers', { provider: 'byo', e164: fakeNumber(i), termination_uri: 'trunk-test.example.com' });
    check(`number ${i + 1} of 3 is fine`, res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
  }
  res = await api(owner, 'POST', '/numbers', { provider: 'byo', e164: fakeNumber(3), termination_uri: 'trunk-test.example.com' });
  check('a fourth hits the plan’s limit (and isn’t imported)',
    res.status === 403 && /Business plan includes 3 phone numbers/.test(res.json?.error) && !(await retellNumber(fakeNumber(3))), `got ${res.status} ${res.json?.error}`);
  check('members read the numbers directly (RLS)', ((await member.db.from('va_phone_numbers').select('id').eq('workspace_id', ws.id)).data ?? []).length === 3);
  check('outsiders read none (RLS)', ((await outsider.db.from('va_phone_numbers').select('id').eq('workspace_id', ws.id)).data ?? []).length === 0);
  const page = await owner.api('GET', `/w/${ws.slug}/numbers`);
  check('Phone numbers page renders', page.status === 200 && /Your numbers/.test(page.text));

  console.log('\nRelease');
  check('members can’t release', (await api(member, 'DELETE', `/numbers/${bought.id}`)).status === 403);
  res = await api(owner, 'DELETE', `/numbers/${bought.id}`);
  check('owner releases the number', res.status === 204, `got ${res.status} ${res.json?.error ?? ''}`);
  check('it’s gone from Retell', !(await retellNumber(bought.e164)));
  const released = (await admin.from('va_phone_numbers').select('status, released_at').eq('id', bought.id).single()).data;
  check('marked released', released.status === 'released' && Boolean(released.released_at));
  check('releasing again is a 404', (await api(owner, 'DELETE', `/numbers/${bought.id}`)).status === 404);
  for (const n of (await api(owner, 'GET', '/numbers')).json.numbers) await api(owner, 'DELETE', `/numbers/${n.id}`);
  check('every number released', !(await retellNumber(fakeNumber(0))) && !(await retellNumber(fakeNumber(1))) && !(await retellNumber(fakeNumber(2))));

  const platform = (await admin.from('va_phone_numbers').select('e164, provider, status').eq('e164', '+15677575800').eq('status', 'active')).data;
  check('the platform workspace kept its Twilio number', platform?.length === 1 && platform[0].provider === 'twilio');
} catch (error) {
  tally.failures++;
  console.error('\nTest run failed:', error.message);
} finally {
  await cleanup(users, slugs);
}

console.log(`\n${tally.failures ? `✗ ${tally.failures} problem(s)` : '✓ All'} · ${tally.checks} checks run.`);
process.exit(tally.failures ? 1 : 0);
