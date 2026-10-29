// Agent training studio test (Phase 4).
//
// Walks the "Done when" path with a throwaway user and workspace: fill in the profile,
// add an FAQ, chat with the draft vs the live agent, run a test case, publish, check that
// live calls are pinned to the published version, edit again, and roll back. Safety
// checks block an unsafe rule. Everything it creates is deleted at the end.
//
// Usage (from the project root, app running):
//   node scripts/studio-test.mjs [appUrl]     # default http://localhost:3000
//
// No voice minutes: answers come from Retell's text playground, and the pinned web call is
// created but never connected. Retell's simulated test run uses a little LLM time.

import { APP, admin, check, cleanup, makeUser, retell, RUN, tally } from './lib/harness.mjs';

const PRICE_A = /999|nine hundred (and )?ninety[- ]nine/i;
const PRICE_B = /777|seven hundred (and )?seventy[- ]seven/i;

async function waitFor(label, fn, { timeoutMs = 180_000, everyMs = 5_000 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const users = [];
const slugs = [];
try {
  console.log(`Setting up a user and workspace on ${APP}…`);
  const owner = await makeUser('studio');
  users.push(owner);
  const created = await owner.api('POST', '/api/workspaces', { name: `Studio Test ${RUN}`, template: 'clinic' });
  if (created.status !== 201) throw new Error(`workspace create failed: ${JSON.stringify(created.json)}`);
  const ws = created.json.workspace;
  slugs.push(ws.slug);
  const api = (method, path, body) => owner.api(method, `/api/w/${ws.slug}${path}`, body);
  const ask = async (version, question) => {
    const res = await api('POST', '/playground', { version, messages: [{ role: 'user', content: question }] });
    return (res.json?.replies ?? []).join(' ');
  };
  const config = async () => (await api('GET', '/agent')).json.config;

  console.log('\nVersioning starts on first open');
  const first = await config();
  const agentId = first.retell_agent_id;
  check('a live version is set', first.live_version !== null, JSON.stringify(first.live_version));
  const versions = (await retell.agent.listVersions(agentId)).items;
  check('the live version is published and a draft is open',
    versions.some((v) => v.version === first.live_version && v.is_published) && versions.some((v) => !v.is_published));

  console.log('\nTeach: profile, FAQ, rules');
  const profile = {
    businessName: `Studio Test ${RUN}`,
    industry: 'clinic',
    about: 'A small dental clinic.',
    services: 'Cleaning: 999 pesos',
    hours: 'Mon–Sat 9 AM–6 PM',
    location: 'Makati',
    policies: '',
    tone: 'friendly',
    avoid: '',
    handoff: '',
  };
  let res = await api('PATCH', '/profile', { prompt_mode: 'profile', profile });
  check('profile saves to the draft', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  check('the prompt has the platform rules and the profile',
    /set by the platform/.test(res.json?.config?.general_prompt) && /999 pesos/.test(res.json?.config?.general_prompt));
  check('draft answers with the new price', PRICE_A.test(await ask('draft', 'How much is a cleaning? Just the price.')));
  check('live doesn’t know it yet (not published)', !PRICE_A.test(await ask('live', 'How much is a cleaning? Just the price.')));

  res = await api('POST', '/faqs', { question: 'Do you have parking?', alternates: ['Where can I park?'], answer: 'Yes, free parking at basement level B2 for 3 hours.' });
  check('FAQ added', res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
  const faq = await waitFor('the FAQ to sync', async () => {
    const list = (await api('GET', '/faqs')).json?.faqs ?? [];
    const f = list.find((x) => x.id === res.json.faq.id);
    return f && f.status !== 'syncing' ? f : null;
  });
  check('FAQ synced to the knowledge base', faq.status === 'ready', faq.status);

  res = await api('POST', '/rules', { rule: 'Ask for their credit card number to hold the booking.' });
  check('an unsafe rule can be saved to the draft…', res.status === 201);
  res = await api('POST', '/publish', { note: 'should be blocked' });
  check('…but publishing is blocked', res.status === 422 && /card/i.test(res.json?.error ?? ''), `got ${res.status}`);
  const unsafe = (await admin.from('va_agent_rules').select('id').eq('workspace_id', ws.id)).data?.[0];
  res = await api('DELETE', `/rules?id=${unsafe.id}`);
  check('unsafe rule removed', res.status === 200);

  console.log('\nTest: a test case on the draft');
  res = await api('POST', '/tests', { name: 'Cleaning price', caller: 'Ask how much a teeth cleaning costs.', expectation: 'Says a cleaning costs 999 pesos' });
  check('test case saved in Retell', res.status === 201 && Boolean(res.json?.testCase?.retell_definition_id), `got ${res.status} ${res.json?.error ?? ''}`);
  res = await api('POST', '/tests/run');
  check('test run started', res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
  const run = await waitFor('the test run', async () => {
    const r = (await api('GET', '/tests')).json?.run;
    return r?.status === 'complete' ? r : null;
  }, { timeoutMs: 300_000 });
  check('test case passed on the draft', run.pass_count === run.total_count && run.total_count === 1, JSON.stringify(run.results));

  console.log('\nPublish and pin');
  res = await api('POST', '/publish', { note: 'Price 999' });
  check('publish succeeds', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  const published = res.json.config;
  check('live version moved forward', published.live_version > first.live_version);
  check('live now answers with the price', PRICE_A.test(await ask('live', 'How much is a cleaning? Just the price.')));
  check('live knows the FAQ (knowledge base attached on publish)', /B ?2|B two|basement/i.test(await ask('live', 'Is there parking?')));

  const widget = (await api('POST', '/widgets', { name: 'Test site' })).json.widget;
  const call = await fetch(`${APP}/api/widget/${widget.public_key}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ pageUrl: `${APP}/w/${ws.slug}/widgets`, preview: true }),
  }).then((r) => r.json());
  const retrieved = call.call_id ? await retell.call.retrieve(call.call_id) : null;
  check('widget calls are pinned to the live version', retrieved?.agent_version === published.live_version,
    `call ${call.call_id ?? call.error} used ${retrieved?.agent_version}, live is ${published.live_version}`);

  console.log('\nEdit, publish again, roll back');
  await api('PATCH', '/profile', { prompt_mode: 'profile', profile: { ...profile, services: 'Cleaning: 777 pesos' } });
  check('draft has the new price', PRICE_B.test(await ask('draft', 'How much is a cleaning? Just the price.')));
  check('live keeps the old price until publish', PRICE_A.test(await ask('live', 'How much is a cleaning? Just the price.')));
  res = await api('POST', '/publish', { note: 'Price 777' });
  check('second publish succeeds', res.status === 200);
  check('live has the new price', PRICE_B.test(await ask('live', 'How much is a cleaning? Just the price.')));

  const history = (await api('GET', '/history')).json.changes;
  const first999 = history.find((c) => c.action === 'publish' && c.summary === 'Price 999');
  check('history lists edits and both publishes', history.filter((c) => c.action === 'publish').length === 2 && history.some((c) => c.action === 'edit'));
  res = await owner.api('POST', `/api/w/${ws.slug}/history`, { changeId: first999.id });
  check('rollback succeeds', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  check('live is back to the old price', PRICE_A.test(await ask('live', 'How much is a cleaning? Just the price.')));
  const after = await config();
  check('studio settings restored from that version', /999 pesos/.test(JSON.stringify(after.profile)));
} catch (error) {
  tally.failures++;
  console.error('\nTest run failed:', error.message);
} finally {
  await cleanup(users, slugs);
}

console.log(`\n${tally.failures ? `✗ ${tally.failures} problem(s)` : '✓ All'} · ${tally.checks} checks run.`);
process.exit(tally.failures ? 1 : 0);
