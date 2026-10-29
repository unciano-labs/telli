import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { prepareDraft } from '@/lib/agent-draft';
import { retellAgentName, type AgentConfig } from '@/lib/agent-config';
import * as twilio from '@/lib/twilio';
import type { Workspace } from '@/lib/workspaces';
import { assertWithinLimit } from '@/lib/billing';

// Phase 5: each workspace's own phone numbers. Every number lives in our one Retell account;
// va_phone_numbers says which workspace owns it. Inbound calls go to the workspace agent's
// latest published version, so drafts never answer the phone.

export type NumberProvider = 'retell' | 'twilio' | 'byo';

export type PhoneNumber = {
  id: string;
  workspace_id: string;
  e164: string;
  provider: NumberProvider;
  provider_sid: string | null;
  country: string;
  nickname: string | null;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  outbound_countries: string[];
  monthly_price_cents: number | null;
  status: 'active' | 'released';
  purchased_at: string;
  released_at: string | null;
};

export class NumberError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** Retell's price for a US/CA number. */
export const RETELL_NUMBER_PRICE_CENTS = 200;
export const RETELL_COUNTRIES = ['US', 'CA'] as const;
export const TWILIO_COUNTRIES = ['US', 'CA', 'PH', 'GB', 'AU'] as const;
/** Countries a customer's own trunk may be allowed to call (our caller only dials PH and US/CA). */
export const CALLABLE_COUNTRIES = ['PH', 'US', 'CA'] as const;
/** Where a customer's SIP trunk sends inbound calls. */
export const RETELL_SIP_URI = 'sip:sip.retellai.com;transport=tcp';

const E164 = /^\+[1-9][0-9]{6,14}$/;
// A hostname with an optional port, nothing else: it's handed to Retell as the trunk address
const SIP_HOST = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i;

function db() {
  return createAdminClient();
}

/** Country of a +1 / +63 number (the only ones the outbound caller accepts). */
export function countryOf(e164: string): string | null {
  if (e164.startsWith('+63')) return 'PH';
  if (e164.startsWith('+1')) return 'US';
  return null;
}

export async function listNumbers(workspaceId: string): Promise<PhoneNumber[]> {
  const { data, error } = await db()
    .from('va_phone_numbers')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load phone numbers: ${error.message}`);
  return data as PhoneNumber[];
}

async function findNumber(workspace: Workspace, id: string): Promise<PhoneNumber> {
  const { data, error } = await db()
    .from('va_phone_numbers')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`Failed to load phone number: ${error.message}`);
  if (!data) throw new NumberError('Phone number not found', 404);
  return data as PhoneNumber;
}

/** The agent binding for inbound/outbound: always the newest published version. */
function agentBinding(config: AgentConfig) {
  return [{ agent_id: config.retell_agent_id, agent_version: 'latest_published', weight: 1 }];
}

function retellNickname(workspace: Workspace, nickname: string | null) {
  return retellAgentName(workspace, nickname || 'phone').slice(0, 100);
}

/** The plan's number allowance (lib/billing). */
async function assertRoom(workspace: Workspace) {
  await assertWithinLimit(workspace, 'numbers', (await listNumbers(workspace.id)).length);
}

/** Retell rejects numbers it already has, including ones deleted moments ago. */
function rejectDuplicate(err: unknown): never {
  if (/already exists/i.test((err as Error).message ?? '')) {
    throw new NumberError('That number is already connected, or was released moments ago. Try again in a few minutes.', 409);
  }
  throw err;
}

/** A number must not already be in our Retell account (it might be another workspace's). */
async function assertNotInRetell(e164: string) {
  const existing = await getRetell()
    .phoneNumber.retrieve(e164)
    .catch((err) => {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    });
  if (existing) throw new NumberError('That number is already connected to Voice Agent', 409);
}

type NewNumber = Pick<PhoneNumber, 'e164' | 'provider' | 'provider_sid' | 'country' | 'nickname' | 'outbound_countries' | 'monthly_price_cents'>;

/** Saves the row; if that fails, undo() removes what was set up in Retell/Twilio. */
async function saveNumber(workspace: Workspace, userId: string, row: NewNumber, undo: () => Promise<void>): Promise<PhoneNumber> {
  const { data, error } = await db()
    .from('va_phone_numbers')
    .insert({ website_id: WEBSITE_ID, workspace_id: workspace.id, ...row, created_by: userId })
    .select('*')
    .single();
  if (error) {
    await undo().catch((err) => console.error('[phone-numbers] cleanup after failed save failed', row.e164, err));
    throw new Error(`Failed to save the phone number: ${error.message}`);
  }
  return data as PhoneNumber;
}

export function normalizeNickname(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().slice(0, 60) || null : null;
}

/** Buys a US/CA number through Retell (Retell bills our account) and binds it to the agent. */
export async function buyRetellNumber(
  workspace: Workspace,
  userId: string,
  input: { country: string; areaCode: string | null; nickname: string | null }
): Promise<PhoneNumber> {
  if (!(RETELL_COUNTRIES as readonly string[]).includes(input.country)) {
    throw new NumberError('Retell sells US and Canadian numbers only', 400);
  }
  if (input.areaCode && !/^[2-9][0-9]{2}$/.test(input.areaCode)) throw new NumberError('Area codes have 3 digits', 400);
  await assertRoom(workspace);
  const config = await prepareDraft(workspace);
  const outboundCountries = [...RETELL_COUNTRIES];

  const number = await getRetell()
    .phoneNumber.create({
      country_code: input.country as 'US' | 'CA',
      ...(input.areaCode && { area_code: Number(input.areaCode) }),
      inbound_agents: agentBinding(config),
      outbound_agents: agentBinding(config),
      allowed_outbound_country_list: outboundCountries,
      nickname: retellNickname(workspace, input.nickname),
    })
    .catch((err) => {
      const message = (err as Error).message ?? '';
      if ((err as { status?: number }).status === 402) {
        throw new NumberError('Retell needs a payment card on file before it can sell numbers. Add one in Retell’s billing settings.', 402);
      }
      if (/area code|no.*available|not available/i.test(message)) {
        throw new NumberError('No numbers are available in that area code. Try another one, or leave it empty.', 409);
      }
      throw err;
    });

  return saveNumber(
    workspace,
    userId,
    {
      e164: number.phone_number,
      provider: 'retell',
      provider_sid: null,
      country: input.country,
      nickname: input.nickname,
      outbound_countries: outboundCountries,
      monthly_price_cents: RETELL_NUMBER_PRICE_CENTS,
    },
    () => getRetell().phoneNumber.delete(number.phone_number)
  );
}

export type NumberOffer = twilio.AvailableNumber & { monthly_price_cents: number | null };

/** Numbers for sale on our Twilio account, with Twilio's monthly price. */
export async function searchTwilioNumbers(country: string, areaCode: string | null): Promise<NumberOffer[]> {
  if (!twilio.twilioConfigured()) throw new NumberError('Buying through Twilio isn’t set up', 503);
  if (!(TWILIO_COUNTRIES as readonly string[]).includes(country)) throw new NumberError('That country isn’t supported yet', 400);
  if (areaCode && !/^[0-9]{1,5}$/.test(areaCode)) throw new NumberError('Enter the area code as digits', 400);
  const [numbers, prices] = await Promise.all([
    twilio.searchAvailableNumbers(country, areaCode ?? undefined),
    twilio.monthlyPrices(country).catch(() => ({}) as Partial<Record<'local' | 'mobile', number>>),
  ]);
  return numbers.map((n) => ({ ...n, monthly_price_cents: prices[n.type] ?? null }));
}

/** Buys a number on our Twilio account, routes it through our SIP trunk and imports it into Retell. */
export async function buyTwilioNumber(
  workspace: Workspace,
  userId: string,
  input: { e164: string; country: string; nickname: string | null }
): Promise<PhoneNumber> {
  if (!twilio.twilioConfigured()) throw new NumberError('Buying through Twilio isn’t set up', 503);
  if (!E164.test(input.e164)) throw new NumberError('Choose a number from the search results', 400);
  if (!(TWILIO_COUNTRIES as readonly string[]).includes(input.country)) throw new NumberError('That country isn’t supported yet', 400);
  await assertRoom(workspace);
  await assertNotInRetell(input.e164);
  const config = await prepareDraft(workspace);
  // For the record; the search showed the price before purchase
  const prices = await twilio.monthlyPrices(input.country).catch(() => ({}) as Partial<Record<'local' | 'mobile', number>>);
  const price = prices.local ?? prices.mobile ?? null;

  const sid = await twilio.buyNumber(input.e164);
  const outboundCountries = [...CALLABLE_COUNTRIES];
  try {
    await twilio.attachToTrunk(sid);
    const trunk = twilio.trunkCredentials();
    await getRetell().phoneNumber.import({
      phone_number: input.e164,
      termination_uri: trunk.termination_uri,
      ...(trunk.username && { sip_trunk_auth_username: trunk.username }),
      ...(trunk.password && { sip_trunk_auth_password: trunk.password }),
      inbound_agents: agentBinding(config),
      outbound_agents: agentBinding(config),
      allowed_outbound_country_list: outboundCountries,
      nickname: retellNickname(workspace, input.nickname),
      transport: 'TCP',
    }).catch(rejectDuplicate);
  } catch (err) {
    // Don't keep paying for a number nobody can use
    await twilio.releaseNumber(sid).catch((e) => console.error('[phone-numbers] release after failed setup failed', sid, e));
    throw err;
  }

  return saveNumber(
    workspace,
    userId,
    {
      e164: input.e164,
      provider: 'twilio',
      provider_sid: sid,
      country: input.country,
      nickname: input.nickname,
      outbound_countries: outboundCountries,
      monthly_price_cents: price,
    },
    async () => {
      await getRetell().phoneNumber.delete(input.e164);
      await twilio.releaseNumber(sid);
    }
  );
}

export type ByoInput = {
  e164: string;
  terminationUri: string;
  username: string | null;
  password: string | null;
  nickname: string | null;
  outboundCountries: string[];
};

export function validateByo(body: Record<string, unknown>): ByoInput {
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');
  const e164 = str('e164').replace(/[\s()-]/g, '');
  if (!E164.test(e164)) throw new NumberError('Enter the number in international format, e.g. +639171234567', 400);
  const terminationUri = str('termination_uri').replace(/^sips?:/i, '');
  if (!SIP_HOST.test(terminationUri)) {
    throw new NumberError('Enter the trunk’s termination address as a hostname, e.g. mytrunk.pstn.twilio.com', 400);
  }
  const username = str('username') || null;
  const password = str('password') || null;
  if ((username && username.length > 128) || (password && password.length > 128)) {
    throw new NumberError('SIP username and password must be under 128 characters', 400);
  }
  const countries = Array.isArray(body.outbound_countries) ? body.outbound_countries : [];
  const outboundCountries = [...new Set(countries.filter((c): c is string => (CALLABLE_COUNTRIES as readonly string[]).includes(c as string)))];
  return { e164, terminationUri, username, password, nickname: normalizeNickname(body.nickname), outboundCountries };
}

/**
 * Imports the customer's own number from their SIP trunk. The SIP credentials go to Retell
 * only; we never store them. To change them, release the number and import it again.
 */
export async function importByoNumber(workspace: Workspace, userId: string, input: ByoInput): Promise<PhoneNumber> {
  await assertRoom(workspace);
  await assertNotInRetell(input.e164);
  const config = await prepareDraft(workspace);
  await getRetell().phoneNumber.import({
    phone_number: input.e164,
    termination_uri: input.terminationUri,
    ...(input.username && { sip_trunk_auth_username: input.username }),
    ...(input.password && { sip_trunk_auth_password: input.password }),
    inbound_agents: agentBinding(config),
    outbound_agents: agentBinding(config),
    // An empty list would mean "any country" in Retell
    allowed_outbound_country_list: input.outboundCountries.length ? input.outboundCountries : [countryOf(input.e164) ?? 'US'],
    nickname: retellNickname(workspace, input.nickname),
    transport: 'TCP',
  }).catch(rejectDuplicate);
  return saveNumber(
    workspace,
    userId,
    {
      e164: input.e164,
      provider: 'byo',
      provider_sid: null,
      country: countryOf(input.e164) ?? 'US',
      nickname: input.nickname,
      outbound_countries: input.outboundCountries.length ? input.outboundCountries : [countryOf(input.e164) ?? 'US'],
      monthly_price_cents: 0,
    },
    () => getRetell().phoneNumber.delete(input.e164)
  );
}

/** Clears the outbound caller ID if it is this number. */
async function clearCallerId(workspace: Workspace, e164: string) {
  await db()
    .from('va_agent_configs')
    .update({ retell_phone_number: null })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('retell_phone_number', e164);
}

/** Turns inbound answering or outbound calling on/off, or renames the number. */
export async function updateNumber(
  workspace: Workspace,
  id: string,
  patch: Partial<Pick<PhoneNumber, 'inbound_enabled' | 'outbound_enabled' | 'nickname'>>
): Promise<PhoneNumber> {
  const number = await findNumber(workspace, id);
  if (patch.inbound_enabled !== undefined || patch.nickname !== undefined) {
    const config = await prepareDraft(workspace);
    await getRetell().phoneNumber.update(number.e164, {
      ...(patch.inbound_enabled !== undefined && { inbound_agents: patch.inbound_enabled ? agentBinding(config) : null }),
      ...(patch.nickname !== undefined && { nickname: retellNickname(workspace, patch.nickname) }),
    });
  }
  const { data, error } = await db()
    .from('va_phone_numbers')
    .update(patch)
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to update the phone number: ${error.message}`);
  if (patch.outbound_enabled === false) await clearCallerId(workspace, number.e164);
  return data as PhoneNumber;
}

/**
 * Releases a number: removed from Retell, then released in Twilio (our numbers), which stops
 * the monthly charge. A customer's own number just stops being connected. Safe to retry.
 */
export async function releasePhoneNumber(workspace: Workspace, userId: string, id: string): Promise<void> {
  const number = await findNumber(workspace, id);
  await getRetell()
    .phoneNumber.delete(number.e164)
    .catch((err) => {
      if ((err as { status?: number }).status !== 404) throw err;
    });
  if (number.provider === 'twilio') {
    if (!twilio.twilioConfigured()) {
      throw new NumberError('Removed from the agent, but Twilio isn’t set up here, so release it in Twilio to stop the charge', 503);
    }
    const sid = number.provider_sid ?? (await twilio.findNumberSid(number.e164));
    if (sid) await twilio.releaseNumber(sid);
  }
  const { error } = await db()
    .from('va_phone_numbers')
    .update({ status: 'released', released_at: new Date().toISOString(), released_by: userId, inbound_enabled: false, outbound_enabled: false })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id);
  if (error) throw new Error(`Released, but failed to save: ${error.message}`);
  await clearCallerId(workspace, number.e164);
}

/** The workspace's numbers that may place outbound calls, for the caller ID picker. */
export async function outboundNumbers(workspaceId: string): Promise<PhoneNumber[]> {
  return (await listNumbers(workspaceId)).filter((n) => n.outbound_enabled);
}
