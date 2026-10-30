// Workspace isolation test (Phase 3).
//
// Creates two throwaway users, each with their own workspace, and checks that neither can
// read or change the other's agent, documents, calls, widgets, team or files: through the
// app's API and directly against Supabase with their own session. Also checks invite and
// role rules and the trial-minute guard. Everything it creates is deleted at the end.
//
// Usage (from the project root, app running):
//   node scripts/isolation-test.mjs [appUrl]     # default http://localhost:3000
//
// Needs .env.local with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY, WEBSITE_ID and RETELL_API_KEY. Creating a workspace creates a
// Retell LLM + agent; the cleanup deletes them. No calls are placed (no voice minutes used).

import { APP, WEBSITE_ID, admin, check, cleanup, makeUser, RUN, tally } from './lib/harness.mjs';

const users = [];
const slugs = [];
try {
  const ping = await fetch(`${APP}/api/workspaces`).catch(() => null);
  if (!ping) throw new Error(`The app isn't reachable at ${APP}`);

  console.log(`Setting up two users and workspaces on ${APP}…`);
  const a = await makeUser('a');
  users.push(a);
  const b = await makeUser('b');
  users.push(b);

  const createdA = await a.api('POST', '/api/workspaces', { name: `Isolation A ${RUN}`, template: 'clinic' });
  const createdB = await b.api('POST', '/api/workspaces', { name: `Isolation B ${RUN}`, template: 'online_store' });
  if (createdA.status !== 201 || createdB.status !== 201) {
    throw new Error(`workspace create failed: ${JSON.stringify(createdA.json)} / ${JSON.stringify(createdB.json)}`);
  }
  const A = createdA.json.workspace;
  const B = createdB.json.workspace;
  slugs.push(A.slug, B.slug);
  check('both workspaces got their own Retell agent', createdA.json.agentReady && createdB.json.agentReady);

  const widgetA = (await a.api('POST', `/api/w/${A.slug}/widgets`, { name: 'A site' })).json?.widget;
  const uploadA = (await a.api('POST', `/api/w/${A.slug}/docs/upload-url`, { fileName: 'a.txt', fileSize: 10 })).json;
  await admin.storage.from('knowledge-docs').uploadToSignedUrl(uploadA.path, uploadA.token, new Blob(['A secret'], { type: 'text/plain' }));

  console.log('\nOwners can use their own workspace');
  check('A reads its agent', (await a.api('GET', `/api/w/${A.slug}/agent`)).status === 200);
  check('A’s upload path is inside its own folder', uploadA.path.startsWith(`${WEBSITE_ID}/${A.id}/`), uploadA.path);
  check('A reads its own workspace row directly (RLS read)', (await a.db.from('va_workspaces').select('id').eq('id', A.id)).data?.length === 1);

  console.log('\nB can’t reach A through the API');
  for (const [method, path, body] of [
    ['GET', `/api/w/${A.slug}/agent`],
    ['PATCH', `/api/w/${A.slug}/agent`, { agent_name: 'pwned', voice_id: 'x', voice_speed: 1, begin_message: 'x', general_prompt: 'x' }],
    ['GET', `/api/w/${A.slug}/docs`],
    ['POST', `/api/w/${A.slug}/docs/upload-url`, { fileName: 'x.txt', fileSize: 10 }],
    ['GET', `/api/w/${A.slug}/calls`],
    ['POST', `/api/w/${A.slug}/test-call`, {}],
    ['GET', `/api/w/${A.slug}/widgets`],
    ['GET', `/api/w/${A.slug}/members`],
    ['POST', `/api/w/${A.slug}/invites`, { email: b.email, role: 'admin' }],
  ]) {
    const res = await b.api(method, path, body);
    check(`${method} ${path.replace(A.slug, '<A>')} → 404`, res.status === 404, `got ${res.status}`);
  }
  let res = await b.api('PATCH', `/api/w/${B.slug}/widgets/${widgetA.id}`, { name: 'pwned' });
  check('B can’t edit A’s widget through B’s own workspace', res.status === 404, `got ${res.status}`);
  res = await b.api('DELETE', `/api/w/${B.slug}/widgets/${widgetA.id}`);
  check('B can’t delete A’s widget through B’s own workspace', res.status === 404, `got ${res.status}`);
  res = await b.api('POST', `/api/w/${B.slug}/docs`, { storagePath: uploadA.path, fileName: 'a.txt' });
  check('B can’t ingest A’s uploaded file into B’s agent', res.status === 400, `got ${res.status}`);
  res = await b.api('PATCH', `/api/platform/workspaces/${A.id}`, { status: 'active' });
  check('B can’t use the platform console', res.status === 403, `got ${res.status}`);
  res = await b.api('GET', '/api/workspaces');
  check('B’s workspace list doesn’t include A', !res.json?.workspaces?.some((w) => w.id === A.id));

  console.log('\nB can’t reach A directly through Supabase (RLS)');
  for (const table of [
    'va_workspaces', 'va_workspace_members', 'va_workspace_invites', 'va_agent_configs', 'va_agent_documents',
    'va_call_logs', 'va_widgets', 'va_widget_events', 'va_agent_faqs', 'va_agent_rules', 'va_agent_changes',
    'va_agent_test_cases', 'va_agent_test_runs', 'va_agent_questions', 'va_agent_corrections', 'va_phone_numbers',
    'va_payments', 'va_workspace_modules', 'va_services', 'va_rentals', 'va_bookings', 'va_rental_private',
  ]) {
    const column = table === 'va_workspaces' ? 'id' : 'workspace_id';
    const { data, error } = await b.db.from(table).select('*').eq(column, A.id);
    check(`select ${table} of A → nothing`, !error && data.length === 0, error?.message ?? `${data?.length} rows`);
  }
  const ins = await b.db.from('va_widgets').insert({ website_id: WEBSITE_ID, workspace_id: B.id, public_key: `wk_${RUN}xxxxxxxxxxxx`.slice(0, 19), name: 'x' });
  check('B can’t insert rows directly, even into B', Boolean(ins.error));
  const upd = await b.db.from('va_workspaces').update({ status: 'active' }).eq('id', B.id).select();
  check('B can’t activate its own trial directly', Boolean(upd.error) || upd.data.length === 0);
  const rpc = await b.db.rpc('va_create_workspace', { p_website_id: WEBSITE_ID, p_user_id: b.id, p_name: 'x', p_slug: `x-${RUN}`, p_template: 'support' });
  check('B can’t call server-only functions', Boolean(rpc.error));
  const role = await b.db.rpc('va_workspace_role', { p_workspace_id: A.id });
  check('va_workspace_role(A) is empty for B', !role.error && role.data === null, role.error?.message);
  const files = await b.db.storage.from('knowledge-docs').list(`${WEBSITE_ID}/${A.id}`);
  check('B can’t list A’s files', (files.data ?? []).length === 0);
  const dl = await b.db.storage.from('knowledge-docs').download(uploadA.path);
  check('B can’t download A’s file', Boolean(dl.error));

  console.log('\nInvites and roles');
  const wrong = await a.api('POST', `/api/w/${A.slug}/invites`, { email: `someone-else-${RUN}@example.com`, role: 'member' });
  res = await b.api('POST', '/api/invites/accept', { token: wrong.json.path.split('/').pop() });
  check('B can’t accept an invite meant for another email', res.status === 403, `got ${res.status}`);
  const invite = await a.api('POST', `/api/w/${A.slug}/invites`, { email: b.email, role: 'member' });
  res = await b.api('POST', '/api/invites/accept', { token: invite.json.path.split('/').pop() });
  check('B accepts A’s invite as member', res.status === 200 && res.json.slug === A.slug, `got ${res.status}`);
  res = await b.api('POST', '/api/invites/accept', { token: invite.json.path.split('/').pop() });
  check('an invite link works only once', res.status === 404, `got ${res.status}`);
  check('member B reads A’s calls', (await b.api('GET', `/api/w/${A.slug}/calls`)).status === 200);
  check('member B can’t change A’s agent', (await b.api('PATCH', `/api/w/${A.slug}/agent`, {})).status === 403);
  check('member B can’t see A’s widgets', (await b.api('GET', `/api/w/${A.slug}/widgets`)).status === 403);
  check('member B can’t invite people', (await b.api('POST', `/api/w/${A.slug}/invites`, { email: 'x@example.com', role: 'member' })).status === 403);
  check('member B can’t make itself owner', (await b.api('PATCH', `/api/w/${A.slug}/members`, { userId: b.id, role: 'owner' })).status === 403);
  check('member B can’t remove owner A', (await b.api('DELETE', `/api/w/${A.slug}/members?userId=${a.id}`)).status === 403);
  check('member B now reads A’s members directly (RLS)', (await b.db.from('va_workspace_members').select('user_id').eq('workspace_id', A.id)).data?.length === 2);
  check('A can’t remove the last owner (itself)', (await a.api('DELETE', `/api/w/${A.slug}/members?userId=${a.id}`)).status === 400);
  check('A removes B', (await a.api('DELETE', `/api/w/${A.slug}/members?userId=${b.id}`)).status === 204);
  check('B loses access after removal', (await b.api('GET', `/api/w/${A.slug}/calls`)).status === 404);

  console.log('\nTrial guard');
  await admin.from('va_workspaces').update({ trial_seconds: 0 }).eq('id', A.id);
  res = await a.api('POST', `/api/w/${A.slug}/test-call`, {});
  check('a used-up trial blocks test calls', res.status === 403 && /trial/i.test(res.json?.error ?? ''), `got ${res.status}`);
  await admin.from('va_workspaces').update({ status: 'suspended' }).eq('id', A.id);
  res = await fetch(`${APP}/api/widget/${widgetA.public_key}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ pageUrl: `${APP}/w/${A.slug}/widgets`, preview: true }),
  });
  check('a suspended workspace’s widget takes no calls', res.status === 503, `got ${res.status}`);
} catch (error) {
  tally.failures++;
  console.error('\nTest run failed:', error.message);
} finally {
  await cleanup(users, slugs);
}

console.log(`\n${tally.failures ? `✗ ${tally.failures} problem(s)` : '✓ All'} · ${tally.checks} checks run.`);
process.exit(tally.failures ? 1 : 0);
