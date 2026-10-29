import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { MAX_CALL_DURATION_MS } from '@/lib/constants';
import { ANALYTICS_TZ } from '@/lib/analytics';
import { getOrProvisionAgentConfig, syncAgentWebhook } from '@/lib/agent-config';
import { refreshUnfinishedCalls } from '@/lib/call-logs';
import { startWebCall, type WebCallToken } from '@/lib/web-calls';
import { getPlatformWorkspace } from '@/lib/workspaces';
import type { DemoLanguageId, DemoScenarioId, DemoStatus } from '@/lib/demo-config';
import type { AgentLanguage } from '@/lib/web-calls';

export type DemoSettings = {
  website_id: string;
  enabled: boolean;
  seconds_per_user: number;
  daily_budget_minutes: number;
  contact_url: string | null;
  retell_agent_id: string | null;
  retell_llm_id: string | null;
  retell_webhook_url: string | null;
  updated_at: string;
};

export type DemoSettingsUpdate = Partial<
  Pick<DemoSettings, 'enabled' | 'seconds_per_user' | 'daily_budget_minutes' | 'contact_url'>
>;

export type DemoLead = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  joined_at: string;
  demo_calls: number;
  demo_seconds: number;
  scenarios: string[];
  last_demo_at: string | null;
};

export class DemoError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
  }
}

/**
 * The demo agent understands these languages together (the most Retell's speech recognition
 * accepts in one set). Filipino can't join the set, so it's a per-call override instead.
 */
const MULTILINGUAL = [
  'en-US', 'es-419', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'pl-PL', 'sv-SE',
  'ru-RU', 'tr-TR', 'ar-SA', 'hi-IN', 'zh-CN', 'ja-JP', 'ko-KR', 'id-ID', 'ms-MY', 'vi-VN',
] as const satisfies AgentLanguage;
const FILIPINO: AgentLanguage = 'fil-PH';
// ElevenLabs Flash v2.5 speaks all of the above with low latency
const DEMO_VOICE = { voice_id: '11labs-Lily', voice_model: 'eleven_flash_v2_5' } as const;

/**
 * Prompt of the dedicated demo agent. The business itself arrives per call as dynamic
 * variables, so scenarios live in code and the website's own agent is never touched.
 */
const DEMO_PROMPT = `{{demo_instructions}}

## How to talk
- This is a phone call: keep replies short (one to three sentences) and natural. Ask one question at a time.
- Reply in the language the caller speaks, and switch if they switch (English, Spanish, French, Filipino, Taglish or any other). Keep business names, addresses and prices as given, but say them naturally in that language.
- Say numbers and prices the way people speak them.

## Demo rules
- This is a live demo of an AI voice agent. The business, people and records above are fictional. Play the role as if they are real, but never claim a booking, payment or delivery happens outside this call.
- Never ask for card numbers, passwords, government ID numbers or other sensitive personal data.
- If asked what you are, say you are an AI voice agent built with Voice Agent, and that any business can get its own agent trained on its documents.
- The call has a time limit because it is a free demo. If the caller asks about it, say so briefly.`;

const SCENARIOS: Record<Exclude<DemoScenarioId, 'support'>, { instructions: string; greeting: string }> = {
  clinic: {
    greeting: 'Good day, Smile Bright Dental Clinic, this is Bea. How can I help you?',
    instructions: `You are Bea, the receptionist at Smile Bright Dental Clinic, 2nd floor, Ayala Tower, Ayala Avenue, Makati.

## Clinic facts
- Hours: Monday to Saturday, 9 AM to 6 PM. Closed Sundays and holidays.
- Dentists: Dr. Ana Reyes (general dentistry) and Dr. Mark Santos (braces and orthodontics).
- Prices: consultation 500 pesos (waived if you go ahead with treatment), cleaning 1,200 pesos, tooth-colored filling from 1,500 pesos, simple extraction 1,500 pesos, whitening 8,000 pesos, braces from 45,000 pesos with monthly installment plans.
- HMOs accepted: Maxicare, Intellicare and MediCard.

## Your job
- Answer questions about services, prices, hours and location.
- To book: ask for the patient's name, the reason for the visit, and a preferred day and time. Offer two open slots near their preference (most slots are open), then confirm the booking back clearly, including the dentist.
- Ask for a mobile number for the appointment reminder.
- For severe pain, swelling or bleeding, offer the earliest same-day emergency slot.`,
  },
  real_estate: {
    greeting: 'Hi, this is Paolo from Northpoint Realty. Are you looking to buy or rent?',
    instructions: `You are Paolo, a property consultant at Northpoint Realty in Metro Manila.

## Your goal
Qualify the caller, suggest the best matches, then set a property viewing.

## Qualify, one question at a time
- Buying or renting; preferred area; property type (condo, or house and lot).
- Budget; when they plan to move; financing (cash, bank loan or Pag-IBIG).

## Listings you can offer
- Studio condo in Makati, 26 square meters, 4.2 million pesos.
- 1-bedroom condo in BGC, 48 square meters, 9.5 million pesos.
- 2-bedroom condo in Ortigas, 62 square meters, 7.8 million pesos.
- 3-bedroom house and lot in Santa Rosa, Laguna, 6.5 million pesos.
- Rentals: 1-bedroom in BGC at 45,000 pesos a month; studio in Makati at 25,000 pesos a month.

## Close
Suggest the one or two best matches. Offer a viewing time, get their name and mobile number, then summarize what was agreed.`,
  },
  online_store: {
    greeting: 'Hi! Thanks for calling Habi Threads, this is Kai. How can I help?',
    instructions: `You are Kai, customer support for Habi Threads, an online clothing store that ships across the Philippines.

## Orders you can look up (always ask for the order number first)
- Order 1042: two linen shirts. Shipped with J&T on October 27, out for delivery, arriving today.
- Order 1043: denim jacket. Being packed, ships within 2 days.
- Order 1050: canvas tote bag. Delivered October 25.
- Any other number: say you can't find it and offer to have the team email them within the day.

## Policies
- Shipping: free over 1,500 pesos. Otherwise 120 pesos in Metro Manila and 180 pesos for provinces. Delivery takes 2 to 4 days in Metro Manila and 5 to 7 days for provinces.
- Returns and exchanges: within 7 days of delivery, unworn with tags. Refunds go back to the original payment method within 5 to 7 business days.
- Payment: GCash, Maya, credit card, or cash on delivery.`,
  },
};

const ERRORS: Record<string, { status: number; message: string }> = {
  disabled: { status: 503, message: 'The demo is turned off right now. Please check back later.' },
  in_progress: { status: 409, message: 'You already have a demo call in progress. End it before starting another.' },
  allowance_used: { status: 403, message: 'You’ve used all your free demo minutes.' },
  daily_budget: { status: 503, message: 'Today’s demo calls are fully booked. Please try again tomorrow.' },
};

function db() {
  return createAdminClient();
}

export async function getDemoSettings(): Promise<DemoSettings | null> {
  const { data, error } = await db().from('va_demo_settings').select('*').eq('website_id', WEBSITE_ID).maybeSingle();
  if (error) throw new Error(`Failed to load demo settings: ${error.message}`);
  return (data as DemoSettings) ?? null;
}

/**
 * Admin only: makes sure the settings row and the dedicated demo agent exist, and that
 * the demo agent reports calls to this deployment's webhook.
 */
export async function ensureDemoAgent(): Promise<DemoSettings> {
  let settings = await getDemoSettings();
  if (!settings) {
    const { error } = await db()
      .from('va_demo_settings')
      .upsert({ website_id: WEBSITE_ID }, { onConflict: 'website_id', ignoreDuplicates: true });
    if (error) throw new Error(`Failed to create demo settings: ${error.message}`);
    settings = (await getDemoSettings())!;
  }

  if (!settings.retell_agent_id) {
    const main = await getOrProvisionAgentConfig(await getPlatformWorkspace());
    const retell = getRetell();
    const llm = await retell.llm.create({
      general_prompt: DEMO_PROMPT,
      begin_message: '{{demo_greeting}}',
      start_speaker: 'agent',
    });
    const agent = await retell.agent.create({
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      agent_name: 'Voice Agent demo',
      ...DEMO_VOICE,
      voice_speed: main.voice_speed,
      language: [...MULTILINGUAL],
      max_call_duration_ms: MAX_CALL_DURATION_MS,
    });

    // Claim atomically: a concurrent admin load may have created one too
    const { data: claimed, error } = await db()
      .from('va_demo_settings')
      .update({ retell_agent_id: agent.agent_id, retell_llm_id: llm.llm_id, updated_at: new Date().toISOString() })
      .eq('website_id', WEBSITE_ID)
      .is('retell_agent_id', null)
      .select('*')
      .maybeSingle();
    if (error || !claimed) {
      await retell.agent.delete(agent.agent_id).catch(() => {});
      await retell.llm.delete(llm.llm_id).catch(() => {});
      if (error) throw new Error(`Failed to save the demo agent: ${error.message}`);
      settings = (await getDemoSettings())!;
    } else {
      settings = claimed as DemoSettings;
    }
  }

  await syncDemoAgent(settings.retell_agent_id!, settings.retell_llm_id!);
  const webhookUrl = await syncAgentWebhook(settings.retell_agent_id!, settings.retell_webhook_url);
  if (webhookUrl) {
    await db().from('va_demo_settings').update({ retell_webhook_url: webhookUrl }).eq('website_id', WEBSITE_ID);
    settings = { ...settings, retell_webhook_url: webhookUrl };
  }
  return settings;
}

/** Brings an existing demo agent up to date with the prompt, voice and languages in this file. */
async function syncDemoAgent(agentId: string, llmId: string): Promise<void> {
  const retell = getRetell();
  const [agent, llm] = await Promise.all([retell.agent.retrieve(agentId), retell.llm.retrieve(llmId)]);
  if (llm.general_prompt !== DEMO_PROMPT) {
    await retell.llm.update(llmId, { general_prompt: DEMO_PROMPT });
  }
  const languages = Array.isArray(agent.language) ? agent.language : [agent.language];
  if (
    agent.voice_id !== DEMO_VOICE.voice_id ||
    agent.voice_model !== DEMO_VOICE.voice_model ||
    languages.join() !== MULTILINGUAL.join()
  ) {
    await retell.agent.update(agentId, { ...DEMO_VOICE, language: [...MULTILINGUAL] });
  }
}

/** Validates admin input. Throws DemoError (400). */
export function validateDemoSettings(body: Record<string, unknown>): DemoSettingsUpdate {
  const update: DemoSettingsUpdate = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new DemoError('enabled must be true or false', 400);
    update.enabled = body.enabled;
  }
  if (body.seconds_per_user !== undefined) {
    const n = Number(body.seconds_per_user);
    if (!Number.isInteger(n) || n < 30 || n > 3600) {
      throw new DemoError('Free time per user must be between 30 seconds and 60 minutes', 400);
    }
    update.seconds_per_user = n;
  }
  if (body.daily_budget_minutes !== undefined) {
    const n = Number(body.daily_budget_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      throw new DemoError('Daily budget must be a whole number of minutes (0 turns calls off)', 400);
    }
    update.daily_budget_minutes = n;
  }
  if (body.contact_url !== undefined) {
    const raw = typeof body.contact_url === 'string' ? body.contact_url.trim() : '';
    if (raw && (!/^(https?:\/\/|mailto:)/i.test(raw) || raw.length > 500)) {
      throw new DemoError('Contact link must start with https://, http:// or mailto:', 400);
    }
    update.contact_url = raw || null;
  }
  return update;
}

export async function updateDemoSettings(update: DemoSettingsUpdate): Promise<DemoSettings> {
  await ensureDemoAgent();
  const { data, error } = await db()
    .from('va_demo_settings')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to save demo settings: ${error.message}`);
  return data as DemoSettings;
}

type StatusRow = {
  enabled: boolean;
  seconds_per_user: number;
  used_seconds: number;
  in_progress: boolean;
  budget_left_seconds: number;
};

async function readStatus(userId: string): Promise<StatusRow> {
  const { data, error } = await db()
    .rpc('va_demo_status', { p_website_id: WEBSITE_ID, p_user_id: userId, p_tz: ANALYTICS_TZ })
    .single();
  if (error) throw new Error(`Failed to load demo status: ${error.message}`);
  return data as StatusRow;
}

export async function getDemoStatus(userId: string): Promise<DemoStatus> {
  await refreshUnfinishedCalls('demo', userId);
  const row = await readStatus(userId);
  return {
    enabled: row.enabled,
    allowanceSeconds: row.seconds_per_user,
    usedSeconds: Math.min(row.used_seconds, row.seconds_per_user),
    remainingSeconds: Math.max(row.seconds_per_user - row.used_seconds, 0),
    inProgress: row.in_progress,
    budgetReached: row.budget_left_seconds < 15,
  };
}

/** Today's demo talk time across all users, for the admin. */
export async function getDemoBudgetUsage(settings: DemoSettings) {
  // Any user id works: the budget part of the status is website-wide
  const row = await readStatus('00000000-0000-0000-0000-000000000000');
  const budgetSeconds = settings.daily_budget_minutes * 60;
  return { budgetSeconds, usedSeconds: Math.max(budgetSeconds - row.budget_left_seconds, 0) };
}

/** Reserves the user's remaining time, then starts a call capped to it. */
export async function startDemoCall(input: {
  userId: string;
  scenario: DemoScenarioId;
  language: DemoLanguageId;
  pageUrl: string | null;
}): Promise<{ token: WebCallToken; allottedSeconds: number }> {
  let settings = await getDemoSettings();
  if (!settings?.enabled) throw new DemoError(ERRORS.disabled.message, 503, 'disabled');
  // The demo agent is normally created on the first Admin → Demo visit; create it here if no admin has opened it yet
  if (input.scenario !== 'support' && !settings.retell_agent_id) settings = await ensureDemoAgent();

  await refreshUnfinishedCalls('demo', input.userId);
  const { data, error } = await db()
    .rpc('va_demo_reserve', {
      p_website_id: WEBSITE_ID,
      p_user_id: input.userId,
      p_scenario: input.scenario,
      p_max_call_seconds: MAX_CALL_DURATION_MS / 1000,
      p_tz: ANALYTICS_TZ,
    })
    .single();
  if (error) throw new Error(`Failed to reserve demo time: ${error.message}`);
  const reservation = data as { session_id: string | null; allotted_seconds: number; error: string | null };
  if (reservation.error || !reservation.session_id) {
    const known = ERRORS[reservation.error ?? ''] ?? { status: 500, message: 'Could not start the demo.' };
    throw new DemoError(known.message, known.status, reservation.error ?? undefined);
  }

  try {
    const scenario = input.scenario === 'support' ? null : SCENARIOS[input.scenario];
    // Demo calls are the platform's own cost, so they're logged under the platform workspace
    const token = await startWebCall({
      workspace: await getPlatformWorkspace(),
      source: 'demo',
      userId: input.userId,
      pageUrl: input.pageUrl,
      agentId: scenario ? settings.retell_agent_id! : undefined,
      maxDurationMs: reservation.allotted_seconds * 1000,
      dynamicVariables: scenario
        ? { demo_instructions: scenario.instructions, demo_greeting: scenario.greeting }
        : undefined,
      // "Our support agent" keeps its own language settings
      language: scenario && input.language === 'fil' ? FILIPINO : undefined,
    });
    await db()
      .from('va_demo_sessions')
      .update({ retell_call_id: token.call_id, status: 'started' })
      .eq('website_id', WEBSITE_ID)
      .eq('id', reservation.session_id);
    return { token, allottedSeconds: reservation.allotted_seconds };
  } catch (err) {
    // The call never existed, so release the reservation
    await db()
      .from('va_demo_sessions')
      .update({ status: 'failed' })
      .eq('website_id', WEBSITE_ID)
      .eq('id', reservation.session_id);
    throw err;
  }
}

export async function listDemoLeads(): Promise<DemoLead[]> {
  const { data, error } = await db().rpc('va_demo_leads', { p_website_id: WEBSITE_ID });
  if (error) throw new Error(`Failed to load leads: ${error.message}`);
  return (data as DemoLead[]).map((l) => ({
    ...l,
    demo_calls: Number(l.demo_calls),
    demo_seconds: Number(l.demo_seconds),
  }));
}

/** For checking scenario prompts without a voice call (Retell playground). */
export function scenarioVariables(scenario: Exclude<DemoScenarioId, 'support'>) {
  return { demo_instructions: SCENARIOS[scenario].instructions, demo_greeting: SCENARIOS[scenario].greeting };
}
