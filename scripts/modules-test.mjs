// Booking modules test (reservations and short-term rentals).
//
// Throwaway clinic and rental workspaces are created through onboarding with sample data.
// The agent functions are called the way Retell calls them during a call (signed POSTs to
// /api/agent-tools): services, availability, booking, double-booking, closed days, stays,
// overlapping stays, capacity. Also the team's Bookings API, roles, and isolation between
// workspaces. Everything is deleted at the end.
//
// Usage (from the project root, app running):
//   node scripts/modules-test.mjs [appUrl]
//
// No calls or Retell minutes: only the agent configuration is read from Retell.

import { sign } from 'retell-sdk';
import { APP, admin, check, cleanup, env, makeUser, retell, RUN, tally } from './lib/harness.mjs';

const KEY = env.RETELL_WEBHOOK_KEY || env.RETELL_API_KEY;
const TZ = 'Asia/Manila';

/** Calls an agent function as Retell would, from that workspace agent's call. */
async function tool(agentId, name, args = {}, callId = `call_test_${RUN}`) {
  const body = JSON.stringify({ name, args, call: { call_id: callId, agent_id: agentId } });
  const res = await fetch(`${APP}/api/agent-tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-retell-signature': await sign(body, KEY) },
    body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, text: json?.result ?? json?.error ?? '' };
}

/** The next date (in Manila) with the given weekday, 0 = Sunday … 6 = Saturday, at least a week out. */
function nextWeekday(weekday) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const plusDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const users = [];
const slugs = [];
try {
  console.log(`Setting up users and workspaces on ${APP}…`);
  const owner = await makeUser('modules-owner');
  const member = await makeUser('modules-member');
  const outsider = await makeUser('modules-outsider');
  users.push(owner, member, outsider);

  const clinic = await owner.api('POST', '/api/workspaces', {
    name: `Clinic ${RUN}`, template: 'clinic', modules: ['reservations'], samples: true, timezone: TZ,
  });
  check('clinic created with the Reservations module', clinic.status === 201 && clinic.json.agentReady, `got ${clinic.status}`);
  const ws = clinic.json.workspace;
  slugs.push(ws.slug);
  const api = (who, method, path, body) => who.api(method, `/api/w/${ws.slug}${path}`, body);
  const invite = await api(owner, 'POST', '/invites', { email: member.email, role: 'member' });
  await member.api('POST', '/api/invites/accept', { token: invite.json.path.split('/').pop() });

  const config = (await admin.from('va_agent_configs').select('*').eq('workspace_id', ws.id).single()).data;
  const agentId = config.retell_agent_id;
  check('the prompt has booking instructions with today’s date', /## Bookings/.test(config.general_prompt) && /current_time_Asia\/Manila/.test(config.general_prompt));
  const llm = await retell.llm.retrieve(config.retell_llm_id);
  const toolNames = (llm.general_tools ?? []).map((t) => t.name);
  const publicUrl = /^https:\/\//.test(env.PUBLIC_APP_URL ?? '') && !/localhost|127\.0\.0\.1/.test(env.PUBLIC_APP_URL);
  check(
    publicUrl ? 'the agent got the booking functions' : 'no public URL: only end_call (the prompt says the team will confirm)',
    publicUrl ? toolNames.includes('book_appointment') : JSON.stringify(toolNames) === '["end_call"]',
    JSON.stringify(toolNames)
  );

  const modules = (await api(member, 'GET', '/modules')).json;
  check('sample services were added', modules?.services?.length === 3 && modules.services.some((s) => s.name === 'Dental cleaning'));

  console.log('\nAgent functions: reservations');
  let res = await fetch(`${APP}/api/agent-tools`, { method: 'POST', body: '{}', headers: { 'x-retell-signature': 'v=1,d=x' } });
  check('unsigned function calls are refused', res.status === 401, `got ${res.status}`);
  res = await tool('agent_not_ours', 'get_services');
  check('unknown agents are refused', res.status === 404, `got ${res.status}`);

  res = await tool(agentId, 'get_services');
  check('get_services lists the services with prices', /Dental cleaning: 60 minutes, \$50/.test(res.text), res.text);
  const monday = nextWeekday(1);
  res = await tool(agentId, 'check_availability', { service: 'dental cleaning', date: monday });
  check('Monday has free times from 9 AM (service names match loosely)', /Free start times: 9:00 AM, 9:30 AM/.test(res.text), res.text);
  check('the last start leaves room for the hour (5 PM, not 5:30)', /5:00 PM\./.test(res.text) && !/5:30 PM/.test(res.text), res.text);

  res = await tool(agentId, 'book_appointment', {
    service: 'Dental cleaning', date: monday, time: '09:00', customer_name: 'Ana Reyes', customer_phone: '09171234567',
  });
  check('book_appointment books it', /^Booked: Dental cleaning for Ana Reyes on Monday/.test(res.text), res.text);
  const booked = (await admin.from('va_bookings').select('*').eq('workspace_id', ws.id)).data;
  check('saved as booked by the agent, in Manila time', booked.length === 1 && booked[0].source === 'call' && booked[0].starts_at.startsWith(`${monday}T01:00:00`),
    JSON.stringify(booked[0]?.starts_at));
  res = await tool(agentId, 'book_appointment', {
    service: 'General consultation', date: monday, time: '09:30', customer_name: 'Ben', customer_phone: '0917',
  });
  check('the hour is blocked for other services too (one at a time)', /isn’t available/.test(res.text), res.text);
  res = await tool(agentId, 'check_availability', { service: 'General consultation', date: monday });
  check('availability skips 9:00 to 10:00', /Free start times: 10:00 AM/.test(res.text), res.text);

  res = await tool(agentId, 'check_availability', { service: 'Follow-up visit', date: nextWeekday(0) });
  check('Sunday is closed, with the next openings offered', /No free times/.test(res.text) && /Next openings: Monday/.test(res.text), res.text);
  res = await tool(agentId, 'check_availability', { service: 'Follow-up visit', date: '2020-01-06' });
  check('past dates are refused', /in the past/.test(res.text), res.text);
  res = await tool(agentId, 'check_availability', { service: 'Massage', date: monday });
  check('unknown services are explained', /no service called "Massage"/.test(res.text), res.text);
  res = await tool(agentId, 'book_appointment', { service: 'Dental cleaning', date: monday, time: '11:00', customer_name: 'Ana' });
  check('a mobile number is required', /mobile number is required/.test(res.text), res.text);

  res = await api(owner, 'PATCH', '/modules', { module: 'reservations', settings: { capacity: 2 } });
  check('owner allows two at a time', res.status === 200 && res.json.module.settings.capacity === 2);
  res = await tool(agentId, 'book_appointment', {
    service: 'General consultation', date: monday, time: '09:30', customer_name: 'Ben Cruz', customer_phone: '09170000000',
  });
  check('now a second patient fits in the same hour', /^Booked:/.test(res.text), res.text);

  console.log('\nThe team’s Bookings API');
  let list = (await api(member, 'GET', '/bookings')).json?.bookings ?? [];
  check('members see the bookings', list.length === 2 && list.every((b) => b.item_name));
  check('members can’t add bookings', (await api(member, 'POST', '/bookings', { kind: 'appointment' })).status === 403);
  check('members can’t change modules', (await api(member, 'PATCH', '/modules', { module: 'reservations', enabled: false })).status === 403);
  check('outsiders get 404', (await api(outsider, 'GET', '/bookings')).status === 404);
  res = await api(owner, 'POST', '/bookings', { kind: 'appointment', service: 'Follow-up visit', date: monday, time: '07:00', customer_name: 'Walk-in' });
  check('the team can add one outside the slot grid', res.status === 201 && res.json.booking.source === 'manual', `got ${res.status} ${res.json?.error ?? ''}`);
  res = await api(owner, 'DELETE', `/bookings?id=${booked[0].id}`);
  check('cancel a booking', res.status === 204);
  res = await tool(agentId, 'check_availability', { service: 'Dental cleaning', date: monday });
  check('the cancelled time is free again', /Free start times: 9:00 AM/.test(res.text), res.text);
  check('outsiders read no bookings directly (RLS)', ((await outsider.db.from('va_bookings').select('id').eq('workspace_id', ws.id)).data ?? []).length === 0);

  res = await api(owner, 'DELETE', `/services?id=${modules.services.find((s) => s.name === 'Follow-up visit').id}`);
  check('a service with bookings is hidden, not deleted', res.status === 200 && res.json.result === 'hidden');

  console.log('\nShort-term rentals');
  const rental = await owner.api('POST', '/api/workspaces', {
    name: `Stays ${RUN}`, template: 'rental', modules: ['rentals'], samples: true, timezone: TZ,
  });
  check('rental workspace created with sample apartments', rental.status === 201, `got ${rental.status}`);
  const ws2 = rental.json.workspace;
  slugs.push(ws2.slug);
  const agent2 = (await admin.from('va_agent_configs').select('retell_agent_id').eq('workspace_id', ws2.id).single()).data.retell_agent_id;

  res = await tool(agent2, 'get_apartments');
  check('get_apartments has prices, address and house rules', /Sunset Studio: \$45 per night/.test(res.text) && /Roxas Boulevard/.test(res.text) && /No parties/.test(res.text), res.text);
  const checkIn = nextWeekday(5);
  res = await tool(agent2, 'check_stay_availability', { check_in: checkIn, check_out: plusDays(checkIn, 3), guests: 2 });
  check('3 nights for 2 guests: both apartments, with totals', /\(3 nights\)/.test(res.text) && /Sunset Studio: \$135 total/.test(res.text) && /Garden Loft.*\$255 total/.test(res.text), res.text);
  res = await tool(agent2, 'check_stay_availability', { check_in: checkIn, check_out: plusDays(checkIn, 2), guests: 4 });
  check('4 guests only fit the loft', !/Sunset Studio/.test(res.text) && /Garden Loft/.test(res.text), res.text);
  res = await tool(agent2, 'book_stay', {
    apartment: 'Sunset Studio', check_in: checkIn, check_out: plusDays(checkIn, 3), guests: 2, customer_name: 'Carla Lim', customer_phone: '09181112222',
  });
  check('book_stay books it with the total and a 6-digit reference', /^Booked: Sunset Studio for Carla Lim, 2 guests/.test(res.text) && /Total \$135/.test(res.text) && /Booking reference \d{3} \d{3}\./.test(res.text), res.text);
  res = await tool(agent2, 'book_stay', {
    apartment: 'Sunset Studio', check_in: plusDays(checkIn, 1), check_out: plusDays(checkIn, 4), guests: 2, customer_name: 'Dan', customer_phone: '0918',
  });
  check('overlapping nights are refused (database constraint)', /already booked/.test(res.text), res.text);
  res = await tool(agent2, 'book_stay', {
    apartment: 'Sunset Studio', check_in: plusDays(checkIn, 3), check_out: plusDays(checkIn, 5), guests: 1, customer_name: 'Eve', customer_phone: '0919',
  });
  check('check-in on the previous guest’s check-out day is fine', /^Booked:/.test(res.text), res.text);
  res = await tool(agent2, 'book_stay', {
    apartment: 'Sunset Studio', check_in: plusDays(checkIn, 10), check_out: plusDays(checkIn, 11), guests: 3, customer_name: 'Fay', customer_phone: '0919',
  });
  check('too many guests for the apartment is refused', /fits up to 2 guests/.test(res.text), res.text);
  res = await tool(agent2, 'check_stay_availability', { check_in: checkIn, check_out: plusDays(checkIn, 2), guests: 2, apartment: 'sunset' });
  check('a booked apartment no longer shows as free', /Nothing is free/.test(res.text), res.text);

  console.log('\nChanges and cancellations by the guest');
  const api2 = (who, method, path, body) => who.api(method, `/api/w/${ws2.slug}${path}`, body);
  const carlaRow = (await admin.from('va_bookings').select('id, reference').eq('workspace_id', ws2.id).eq('customer_name', 'Carla Lim').single()).data;
  check('bookings get a 6-digit reference', /^\d{6}$/.test(carlaRow.reference), carlaRow.reference);
  // Said the way a caller would: in two groups of three
  const carla = { booking_reference: `${carlaRow.reference.slice(0, 3)} ${carlaRow.reference.slice(3)}`, phone: '0918 111 2222' };
  let step = 0;
  const as = (name, args) => tool(agent2, name, args, `call_change_${RUN}_${step++}`);
  res = await as('find_booking', { ...carla, phone: '09170000000' });
  check('a wrong mobile number finds nothing', /No confirmed upcoming stay/.test(res.text), res.text);
  res = await as('find_booking', carla);
  check('find_booking reads back the stay and the policy', /Verified stay: Sunset Studio/.test(res.text) && /3 nights, total \$135/.test(res.text) && /Cancelling now is free/.test(res.text), res.text);
  res = await as('change_stay', { ...carla, check_out: plusDays(checkIn, 4) });
  check('extending into the next guest’s nights is refused', /isn’t free for those dates/.test(res.text), res.text);
  res = await as('change_stay', { ...carla, apartment: 'Garden Loft' });
  check('switching apartment re-prices the stay', /^Updated: Garden Loft/.test(res.text) && /New total \$255 \(was \$135; \$120 more\)/.test(res.text), res.text);
  res = await as('change_stay', { ...carla, guests: 9 });
  check('too many guests for the new apartment is refused', /fits up to 5 guests/.test(res.text), res.text);
  res = await api2(owner, 'PATCH', '/modules', { module: 'rentals', settings: { cancel_free_days: 30, cancel_fee_percent: 50, change_cutoff_hours: 720 } });
  check('owner tightens the policy (30 days free, 50% fee, changes until 30 days before)', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  res = await as('find_booking', carla);
  check('find_booking now quotes the fee', /Cancelling now costs \$127\.50 \(50% of the total\)/.test(res.text), res.text);
  const eveRow = (await admin.from('va_bookings').select('id, reference').eq('workspace_id', ws2.id).eq('customer_name', 'Eve').single()).data;
  const eve = { booking_reference: eveRow.reference, phone: '09190000000' };
  await admin.from('va_bookings').update({ customer_phone: '09190000000' }).eq('workspace_id', ws2.id).eq('customer_name', 'Eve');
  res = await as('change_stay', { ...eve, check_in: plusDays(checkIn, 4) });
  check('moving dates inside the change window is refused', /only possible until 720 hours before check-in/.test(res.text), res.text);
  res = await as('change_stay', { ...eve, check_out: plusDays(checkIn, 6) });
  check('but extending check-out is still allowed', /^Updated: Sunset Studio/.test(res.text) && /\$135 \(was \$90; \$45 more\)/.test(res.text), res.text);
  res = await as('cancel_stay', carla);
  check('cancelling charges the policy fee', /^Cancelled\. Under the cancellation policy a fee of \$127\.50/.test(res.text), res.text);
  const cancelled = (await admin.from('va_bookings').select('status, cancellation_fee_cents, history').eq('id', carlaRow.id).single()).data;
  check('the booking records the fee and both changes', cancelled.status === 'cancelled' && cancelled.cancellation_fee_cents === 12750 && cancelled.history.length === 2,
    JSON.stringify(cancelled));
  res = await as('cancel_stay', carla);
  check('a cancelled booking can’t be found again', /No confirmed upcoming stay/.test(res.text), res.text);
  check('members still can’t change bookings through the API', (await member.api('DELETE', `/api/w/${ws2.slug}/bookings?id=${carlaRow.id}`)).status === 404);

  console.log('\nPrivate apartment details');
  const apartments = (await api2(owner, 'GET', '/modules')).json.rentals;
  const loft = apartments.find((r) => r.name.startsWith('Garden Loft'));
  res = await api2(owner, 'PUT', `/rentals/private?id=${loft.id}`, { guest_info: 'Key safe left of the gate. Code: 4321', internal_notes: 'Staff code 9999' });
  check('owner saves guest-only and team-only details', res.status === 200, `got ${res.status} ${res.json?.error ?? ''}`);
  res = await tool(agent2, 'get_apartment_details', { apartment: 'garden loft' });
  check('public details never include private ones', /Garden Loft/.test(res.text) && !/4321|9999/.test(res.text), res.text);
  res = await tool(agent2, 'get_apartments');
  check('nor does the apartment list', !/4321|9999/.test(res.text));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  res = await api2(owner, 'POST', '/bookings', { kind: 'stay', apartment: 'Garden Loft', check_in: today, check_out: plusDays(today, 2), guests: 2, customer_name: 'Gina Guest', customer_phone: '+63 917 555 0101' });
  check('a stay starting today', res.status === 201, `got ${res.status} ${res.json?.error ?? ''}`);
  const ref = res.json.booking.reference;
  res = await tool(agent2, 'get_guest_access', { booking_reference: ref, phone: '09170000000' });
  check('wrong mobile number: no codes', /No confirmed upcoming stay/.test(res.text) && !/4321/.test(res.text), res.text);
  res = await tool(agent2, 'get_guest_access', eve);
  check('a stay more than 24 hours away: not yet', /only shared from 24 hours/.test(res.text), res.text);
  res = await tool(agent2, 'get_guest_access', { booking_reference: ref, phone: '0917 555 0101' });
  check('reference + mobile within 24h: the guest gets the code', /Verified guest/.test(res.text) && /4321/.test(res.text) && !/9999/.test(res.text), res.text);
  res = await tool(agent2, 'get_guest_access', { booking_reference: ref, phone: '0917 555 0101' });
  check('at most 3 tries per call', /Too many tries/.test(res.text), res.text);
  check('members can’t read private details', (await member.api('GET', `/api/w/${ws2.slug}/rentals/private?id=${loft.id}`)).status === 404);
  check('outsiders read no private details directly (RLS)', ((await outsider.db.from('va_rental_private').select('rental_id').eq('workspace_id', ws2.id)).data ?? []).length === 0);
  check('the owner can (RLS: owners and admins)', ((await owner.db.from('va_rental_private').select('rental_id').eq('workspace_id', ws2.id)).data ?? []).length === 1);

  console.log('\nIsolation between workspaces');
  res = await tool(agent2, 'get_services');
  check('the rental agent can’t see the clinic’s services', /No services are set up/.test(res.text), res.text);
  res = await tool(agentId, 'get_apartments');
  check('the clinic agent can’t see the rental’s apartments', /No apartments are set up/.test(res.text), res.text);

  const history = (await owner.api('GET', `/api/w/${ws.slug}/history`)).json?.changes ?? [];
  res = await api(owner, 'PATCH', '/modules', { module: 'rentals', enabled: true });
  const after = (await owner.api('GET', `/api/w/${ws.slug}/history`)).json?.changes ?? [];
  check('turning a module on is a draft edit in History', after.length === history.length + 1 && /Turned on Short-term rentals/.test(after[0]?.summary));
  const draftPrompt = (await admin.from('va_agent_configs').select('general_prompt').eq('workspace_id', ws.id).single()).data.general_prompt;
  check('the draft prompt still has the booking section once', (draftPrompt.match(/## Bookings/g) ?? []).length === 1);
  const page = await member.api('GET', `/w/${ws.slug}/bookings`);
  check('members see the live Bookings page with reservations and services', page.status === 200 && /Ben Cruz/.test(page.text) && /What you offer/.test(page.text) && /Dental cleaning/.test(page.text));
  check('the workspace menu has a Bookings tab', page.text.includes(`href="/w/${ws.slug}/bookings"`));
  const setup = await owner.api('GET', `/w/${ws.slug}/modules`);
  check('Agent → Modules shows the setup', setup.status === 200 && /Opening hours/.test(setup.text) && /Apartments/.test(setup.text));
  const rentalPage = await owner.api('GET', `/w/${ws2.slug}/bookings`);
  check('the rental dashboard shows nights booked and apartments', /Nights booked/.test(rentalPage.text) && /Carla Lim|Carla/.test(rentalPage.text) && /Garden Loft/.test(rentalPage.text));

  const plain = await owner.api('POST', '/api/workspaces', { name: `Plain ${RUN}`, template: 'support' });
  slugs.push(plain.json.workspace.slug);
  const plainPage = await owner.api('GET', `/w/${plain.json.workspace.slug}/team`);
  check('no Bookings tab without a module', plainPage.status === 200 && !plainPage.text.includes(`href="/w/${plain.json.workspace.slug}/bookings"`));
} catch (error) {
  tally.failures++;
  console.error('\nTest run failed:', error.message);
} finally {
  await cleanup(users, slugs);
}

console.log(`\n${tally.failures ? `✗ ${tally.failures} problem(s)` : '✓ All'} · ${tally.checks} checks run.`);
process.exit(tally.failures ? 1 : 0);
