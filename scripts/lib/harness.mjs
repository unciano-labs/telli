// Shared setup for the end-to-end scripts in scripts/: env, Supabase and Retell clients,
// throwaway signed-in users, and cleanup of everything a run created.

import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import Retell from 'retell-sdk';

export const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
export const APP = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const WEBSITE_ID = env.WEBSITE_ID;
export const admin = createClient(SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
export const retell = new Retell({ apiKey: env.RETELL_API_KEY });

export const RUN = Date.now().toString(36);
const PASSWORD = `Test-${RUN}-${Math.random().toString(36).slice(2)}!`;
export const tally = { checks: 0, failures: 0 };

export function check(name, ok, detail = '') {
  tally.checks++;
  if (!ok) tally.failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
}

/**
 * A signed-in test user: cookies for the app's API, and a Supabase client using their own JWT.
 * role 'admin' makes them website admin (platform staff), enrolled with the service role.
 */
export async function makeUser(label, { role = 'user' } = {}) {
  const email = `va-e2e-${label}-${RUN}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `E2E ${label.toUpperCase()}` },
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const enroll = await admin.rpc('enroll_user_in_website', {
    p_website_id: WEBSITE_ID,
    p_user_id: data.user.id,
    p_role_name: role,
    p_full_name: `E2E ${label.toUpperCase()}`,
  });
  if (enroll.error) throw new Error(`enroll ${label}: ${enroll.error.message}`);

  // Same cookie format the app's @supabase/ssr server client reads
  const jar = new Map();
  const ssr = createServerClient(SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const signIn = await ssr.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error) throw new Error(`signIn ${label}: ${signIn.error.message}`);
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');

  const db = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.data.session.access_token}` } },
  });

  async function api(method, path, body, headers = {}) {
    const res = await fetch(APP + path, {
      method,
      redirect: 'manual',
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json, text };
  }

  return { label, email, id: data.user.id, api, db };
}

/** Gives a workspace one paid month of a plan (as platform staff would), so tests aren't held to trial limits. */
export async function grantPlan(workspaceId, code = 'business') {
  const { data: payment, error } = await admin
    .from('va_payments')
    .insert({ website_id: WEBSITE_ID, workspace_id: workspaceId, plan_code: code, amount_cents: 0, line_items: [{ name: `${code} (test)`, amount_cents: 0 }] })
    .select('id')
    .single();
  if (error) throw new Error(`grantPlan: ${error.message}`);
  const applied = await admin.rpc('va_apply_payment', {
    p_website_id: WEBSITE_ID,
    p_payment_id: payment.id,
    p_paymongo_payment_id: null,
    p_payment_method: 'granted',
  });
  if (applied.error) throw new Error(`grantPlan: ${applied.error.message}`);
}

/** Deletes the workspaces (with their Retell agent, LLM, KB and files) and the users. */
export async function cleanup(users, slugs) {
  console.log('\nCleaning up…');
  for (const slug of slugs) {
    const { data: ws } = await admin.from('va_workspaces').select('id').eq('website_id', WEBSITE_ID).eq('slug', slug).maybeSingle();
    if (!ws) continue;
    const { data: cfg } = await admin.from('va_agent_configs').select('*').eq('workspace_id', ws.id).maybeSingle();
    if (cfg) {
      await retell.agent.delete(cfg.retell_agent_id).catch((e) => console.log('  agent delete:', e.message));
      await retell.llm.delete(cfg.retell_llm_id).catch((e) => console.log('  llm delete:', e.message));
      if (cfg.retell_kb_id) await retell.knowledgeBase.delete(cfg.retell_kb_id).catch(() => {});
    }
    const { data: tests } = await admin.from('va_agent_test_cases').select('retell_definition_id').eq('workspace_id', ws.id);
    for (const t of tests ?? []) {
      if (t.retell_definition_id) await retell.tests.deleteTestCaseDefinition(t.retell_definition_id).catch(() => {});
    }
    // Numbers cost money every month: never leave one behind
    const { data: numbers } = await admin.from('va_phone_numbers').select('e164').eq('workspace_id', ws.id).eq('status', 'active');
    for (const n of numbers ?? []) {
      await retell.phoneNumber.delete(n.e164).then(
        () => console.log(`  released ${n.e164}`),
        (e) => console.log(`  number ${n.e164} delete:`, e.message)
      );
    }
    const { data: files } = await admin.storage.from('knowledge-docs').list(`${WEBSITE_ID}/${ws.id}`);
    if (files?.length) await admin.storage.from('knowledge-docs').remove(files.map((f) => `${WEBSITE_ID}/${ws.id}/${f.name}`));
    await admin.from('va_workspaces').delete().eq('id', ws.id);
  }
  for (const user of users) {
    const { data: profiles } = await admin.from('user_profiles').select('id').eq('user_id', user.id);
    const ids = (profiles ?? []).map((p) => p.id);
    if (ids.length) {
      await admin.from('user_roles').delete().in('user_profile_id', ids);
      await admin.from('user_profiles').delete().in('id', ids);
    }
    const { error } = await admin.auth.admin.deleteUser(user.id);
    console.log(`  user ${user.label}: ${error ? `not deleted (${error.message})` : 'deleted'}`);
  }
}
