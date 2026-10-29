// "Learn from real calls" test (Phase 4C).
//
// A throwaway owner and member work through the Improve tab: real widget calls are created
// in Retell, then their analysis is delivered through the signed webhook (as Retell would
// after a conversation). Checks the unanswered-questions inbox and its grouping, caller
// 👍/👎, the review queue order, member suggestions and owner approval, wrong-answer fixes
// as an FAQ and as a rule, and that the live agent then answers. Everything is deleted at the end.
//
// Usage (from the project root, app running):
//   node scripts/improve-test.mjs [appUrl]     # default http://localhost:3000
//
// No voice minutes: the web calls are created but never connected.

import { sign } from 'retell-sdk';
import { APP, admin, check, cleanup, env, grantPlan, makeUser, retell, RUN, tally } from './lib/harness.mjs';

const WEBHOOK_KEY = env.RETELL_WEBHOOK_KEY || env.RETELL_API_KEY;

async function waitFor(label, fn, { timeoutMs = 180_000, everyMs = 5_000 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Delivers a signed call_analyzed event, like Retell does once a call is analyzed. */
async function deliverAnalysis(call, { transcript, resolved, unanswered, intent, sentiment = 'Neutral' }) {
  const now = Date.now();
  const body = JSON.stringify({
    event: 'call_analyzed',
    call: {
      call_id: call.call_id,
      call_type: 'web_call',
      agent_id: call.agent_id,
      call_status: 'ended',
      start_timestamp: now - 95_000,
      end_timestamp: now - 5_000,
      duration_ms: 90_000,
      disconnection_reason: 'user_hangup',
      transcript,
      call_analysis: {
        call_summary: 'The caller asked about opening days and parking.',
        user_sentiment: sentiment,
        call_successful: resolved,
        custom_analysis_data: { resolved, unanswered_questions: unanswered, caller_intent: intent },
      },
    },
  });
  const res = await fetch(`${APP}/api/webhooks/retell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-retell-signature': await sign(body, WEBHOOK_KEY) },
    body,
  });
  return res.status;
}

const users = [];
const slugs = [];
try {
  console.log(`Setting up an owner, a member and a workspace on ${APP}…`);
  const owner = await makeUser('improve-owner');
  const member = await makeUser('improve-member');
  const outsider = await makeUser('improve-outsider');
  users.push(owner, member, outsider);
  const created = await owner.api('POST', '/api/workspaces', { name: `Improve Test ${RUN}`, template: 'clinic' });
  if (created.status !== 201) throw new Error(`workspace create failed: ${JSON.stringify(created.json)}`);
  const ws = created.json.workspace;
  slugs.push(ws.slug);
  // A plan, not the trial: two widgets, and room for unconnected calls (5 minutes each while open)
  await grantPlan(ws.id, 'business');
  const api = (who, method, path, body) => who.api(method, `/api/w/${ws.slug}${path}`, body);
  const invite = await api(owner, 'POST', '/invites', { email: member.email, role: 'member' });
  await member.api('POST', '/api/invites/accept', { token: invite.json.path.split('/').pop() });

  const config = (await api(owner, 'GET', '/agent')).json.config;
  const agentId = config.retell_agent_id;
  const live = await retell.agent.retrieve(agentId, { version: config.live_version });
  check('new agents carry the analysis fields',
    ['resolved', 'unanswered_questions', 'caller_intent'].every((n) => live.post_call_analysis_data?.some((f) => f.name === n)),
    JSON.stringify(live.post_call_analysis_data));

  console.log('\nCalls come in and get analyzed');
  const widget = (await api(owner, 'POST', '/widgets', { name: 'Clinic site' })).json.widget;
  const startCall = () =>
    fetch(`${APP}/api/widget/${widget.public_key}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ pageUrl: `${APP}/pricing`, visitorId: `v-${RUN}` }),
    }).then((r) => r.json());
  const callA = await startCall();
  const callB = await startCall();
  check('widget calls start (with the analysis override)', Boolean(callA.call_id && callB.call_id), callA.error ?? callB.error);
  const testCall = await api(owner, 'POST', '/test-call');
  check('test calls start too', testCall.status === 200, `got ${testCall.status} ${testCall.json?.error ?? ''}`);
  for (const c of [callA, callB, testCall.json]) c.agent_id = agentId;

  const transcriptA = [
    'Agent: Hi! Thanks for calling. How can I help?',
    'User: Hi, do you open on Sundays?',
    'Agent: Yes, we are open every Sunday from 8 AM.',
    'User: Okay. And is there parking near the clinic?',
    'Agent: I’m not sure about parking, sorry.',
    'User: Okay, bye.',
  ].join('\n');
  const transcriptB = [
    'Agent: Hi! How can I help?',
    'User: Are you open on Sunday?',
    'Agent: Let me check... I don’t have that information.',
    'User: How much is a cleaning?',
    'Agent: A cleaning is 999 pesos.',
  ].join('\n');
  let status = await deliverAnalysis(callA, {
    transcript: transcriptA,
    resolved: false,
    unanswered: 'Do you open on Sundays?\nIs there parking near the clinic?',
    intent: 'information',
    sentiment: 'Negative',
  });
  check('signed webhook accepted', status === 204, `got ${status}`);
  await deliverAnalysis(callA, { transcript: transcriptA, resolved: false, unanswered: 'Do you open on Sundays?\nIs there parking near the clinic?', intent: 'information' });
  await deliverAnalysis(callB, { transcript: transcriptB, resolved: true, unanswered: '- Are you open on Sunday?', intent: 'pricing' });
  await deliverAnalysis(testCall.json, { transcript: transcriptB, resolved: false, unanswered: 'Do you do braces?', intent: 'information' });
  const unsigned = await fetch(`${APP}/api/webhooks/retell`, { method: 'POST', body: '{}', headers: { 'x-retell-signature': 'v=1,d=x' } });
  check('unsigned webhooks are rejected', unsigned.status === 401, `got ${unsigned.status}`);

  const row = (await admin.from('va_call_logs').select('*').eq('retell_call_id', callA.call_id).single()).data;
  check('analysis saved on the call', row.resolved === false && row.caller_intent === 'information' && row.status === 'ended');

  let groups = (await api(member, 'GET', '/improve/questions')).json?.groups ?? [];
  const sunday = groups.find((g) => /sunday/i.test(g.question));
  const parking = groups.find((g) => /parking/i.test(g.question));
  check('inbox has two groups (Sunday asked twice, parking once)', groups.length === 2 && sunday?.count === 2 && parking?.count === 1,
    JSON.stringify(groups.map((g) => [g.question, g.count])));
  check('the same analysis delivered twice doesn’t double-count', sunday?.call_ids.length === 2);
  check('test calls stay out of the inbox', !groups.some((g) => /braces/i.test(g.question)));

  console.log('\nCaller feedback');
  const feedback = (key, call, rating, comment) =>
    fetch(`${APP}/api/widget/${key}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ callId: call.call_id, rating, comment, pageUrl: `${APP}/pricing` }),
    });
  await feedback(widget.public_key, callA, 'down', 'It said Sunday but you are closed!');
  await feedback(widget.public_key, callA, 'up', 'changed my mind');
  const other = (await api(owner, 'POST', '/widgets', { name: 'Other site' })).json.widget;
  await feedback(other.public_key, callB, 'down', 'not my call');
  const rated = (await admin.from('va_call_logs').select('retell_call_id, feedback_rating, feedback_comment').in('retell_call_id', [callA.call_id, callB.call_id])).data;
  const ratedA = rated.find((r) => r.retell_call_id === callA.call_id);
  check('👎 and the comment are saved', ratedA?.feedback_rating === 'down' && /closed/.test(ratedA.feedback_comment ?? ''));
  check('a call can be rated only once', ratedA?.feedback_rating === 'down');
  check('another widget can’t rate the call', rated.find((r) => r.retell_call_id === callB.call_id)?.feedback_rating === null);

  console.log('\nReview queue');
  let queue = (await api(member, 'GET', '/improve/calls')).json?.calls ?? [];
  check('needs review: 👎 call first, then the call with an unanswered question',
    queue.length === 2 && queue[0].feedback_rating === 'down' && queue[1].unanswered.length === 1,
    JSON.stringify(queue.map((c) => [c.feedback_rating, c.resolved, c.unanswered])));

  console.log('\nMember suggestions, owner approval');
  let res = await api(member, 'POST', '/improve/corrections', {
    fix_type: 'faq', question: 'Do you open on Sundays?', correction: 'No, we are closed on Sundays.', question_ids: sunday.ids,
  });
  check('member suggests an answer', res.status === 201 && res.json.correction.status === 'pending', `got ${res.status} ${res.json?.error ?? ''}`);
  const suggestion = res.json.correction;
  check('member can’t apply it', (await api(member, 'PATCH', `/improve/corrections?id=${suggestion.id}`, { action: 'apply', fix_type: 'faq', question: 'x', correction: 'y' })).status === 403);
  check('member can’t ignore questions', (await api(member, 'POST', '/improve/questions', { action: 'ignore', ids: parking.ids })).status === 403);
  check('member can’t mark calls reviewed', (await api(member, 'PATCH', `/improve/calls?id=${queue[0].id}`, { reviewed: true })).status === 403);
  check('outsider can’t see the inbox', (await outsider.api('GET', `/api/w/${ws.slug}/improve/questions`)).status === 404);
  check('outsider reads no questions directly (RLS)', ((await outsider.db.from('va_agent_questions').select('id').eq('workspace_id', ws.id)).data ?? []).length === 0);
  check('outsider reads no fixes directly (RLS)', ((await outsider.db.from('va_agent_corrections').select('id').eq('workspace_id', ws.id)).data ?? []).length === 0);
  check('member reads the inbox directly (RLS)', ((await member.db.from('va_agent_questions').select('id').eq('workspace_id', ws.id)).data ?? []).length === 3);

  res = await api(owner, 'PATCH', `/improve/corrections?id=${suggestion.id}`, {
    action: 'apply', fix_type: 'faq', question: 'Do you open on Sundays?', correction: 'No. We are closed on Sundays and open Monday to Saturday, 9 AM to 6 PM.',
  });
  check('owner applies it (edited)', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  check('it can’t be applied twice', (await api(owner, 'PATCH', `/improve/corrections?id=${suggestion.id}`, { action: 'apply', fix_type: 'rule', correction: 'x' })).status === 409);
  const sundayFaq = (await admin.from('va_agent_faqs').select('*').eq('workspace_id', ws.id).eq('origin', 'unanswered')).data?.[0];
  check('FAQ created from the inbox, with the other wording', /Monday to Saturday/.test(sundayFaq?.answer ?? '') && sundayFaq?.alternates.some((a) => /open on Sunday\?/.test(a)),
    JSON.stringify(sundayFaq));
  groups = (await api(owner, 'GET', '/improve/questions')).json.groups;
  check('the Sunday questions left the inbox', groups.length === 1 && /parking/i.test(groups[0].question));
  check('owner ignores the parking question', (await api(owner, 'POST', '/improve/questions', { action: 'ignore', ids: groups[0].ids })).status === 204);
  check('inbox is empty', ((await api(owner, 'GET', '/improve/questions')).json.groups ?? []).length === 0);

  console.log('\nWrong answers from a transcript');
  const callRowA = queue[0];
  res = await api(owner, 'POST', '/improve/corrections', { call_log_id: callRowA.id, position: 1, fix_type: 'rule', correction: 'x' });
  check('a caller line can’t be marked as a wrong answer', res.status === 400, `got ${res.status}`);
  res = await api(owner, 'POST', '/improve/corrections', {
    call_log_id: callRowA.id, position: 4, fix_type: 'rule', correction: 'If you don’t know something, offer to have the clinic text the caller back.',
  });
  check('owner fixes a reply with a rule (applied at once)', res.status === 201 && res.json.correction.status === 'applied', `got ${res.status} ${res.json?.error ?? ''}`);
  check('it saved the caller line and the wrong reply', /parking/.test(res.json.correction.caller_said) && /not sure/.test(res.json.correction.original_reply));
  const rule = (await admin.from('va_agent_rules').select('*').eq('workspace_id', ws.id).eq('origin', 'correction')).data?.[0];
  check('the rule is in the draft', Boolean(rule) && /text the caller back/.test((await api(owner, 'GET', '/agent')).json.config.general_prompt));

  res = await api(member, 'POST', '/improve/corrections', {
    call_log_id: callRowA.id, position: 2, fix_type: 'faq', question: 'Do you open on Sundays?', correction: 'Closed Sundays.',
  });
  check('member flags a wrong answer (saved as a suggestion)', res.status === 201 && res.json.correction.status === 'pending');
  check('owner dismisses it', (await api(owner, 'PATCH', `/improve/corrections?id=${res.json.correction.id}`, { action: 'dismiss' })).status === 204);
  const fixes = (await api(member, 'GET', '/improve/corrections')).json.corrections;
  check('fixes list shows applied and dismissed fixes', fixes.length === 3 && fixes.some((f) => f.status === 'dismissed'));

  queue = (await api(owner, 'GET', '/improve/calls?filter=all')).json.calls;
  check('the fixed reply is marked in the transcript', queue.find((c) => c.id === callRowA.id)?.fixed_positions.includes(4));
  check('owner marks the call reviewed', (await api(owner, 'PATCH', `/improve/calls?id=${callRowA.id}`, { reviewed: true })).status === 204);
  queue = (await api(owner, 'GET', '/improve/calls')).json.calls;
  check('reviewed calls leave the queue', !queue.some((c) => c.id === callRowA.id) && queue.length === 1);

  console.log('\nQuality and the live agent');
  const page = await owner.api('GET', `/w/${ws.slug}/improve`);
  check('Improve page renders', page.status === 200 && /Call quality/.test(page.text) && /Why people call/.test(page.text), `got ${page.status}`);
  check('member can open it too', (await member.api('GET', `/w/${ws.slug}/improve`)).status === 200);

  await waitFor('the FAQ to sync', async () => {
    const list = (await api(owner, 'GET', '/faqs')).json?.faqs ?? [];
    return list.find((f) => f.id === sundayFaq.id && f.status !== 'syncing');
  });
  res = await api(owner, 'POST', '/publish', { note: 'Fixes from call review' });
  check('publish with the new rule', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  const reply = (await api(owner, 'POST', '/playground', { version: 'live', messages: [{ role: 'user', content: 'Are you open on Sundays?' }] })).json?.replies?.join(' ') ?? '';
  check('the live agent now says Sundays are closed', /closed|not open|don.t open/i.test(reply), reply);
} catch (error) {
  tally.failures++;
  console.error('\nTest run failed:', error.message);
} finally {
  await cleanup(users, slugs);
}

console.log(`\n${tally.failures ? `✗ ${tally.failures} problem(s)` : '✓ All'} · ${tally.checks} checks run.`);
process.exit(tally.failures ? 1 : 0);
