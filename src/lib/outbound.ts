import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { getOrProvisionAgentConfig } from '@/lib/agent-config';
import { insertCallLog, type CallLog } from '@/lib/call-logs';
import { MAX_CALL_DURATION_MS, normalizePhoneNumber, renderGreeting } from '@/lib/constants';
import type { Workspace } from '@/lib/workspaces';
import { assertOutboundAllowed, callLimitMs } from '@/lib/billing';
import { ANALYSIS_FIELDS } from '@/lib/call-analysis';
import { countryOf, outboundNumbers, type PhoneNumber } from '@/lib/phone-numbers';

export type OutboundSettings = {
  retell_phone_number: string | null;
  outbound_begin_message: string;
};

export class OutboundError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function db() {
  return createAdminClient();
}

/** The workspace's outbound caller ID, if it's still one of its own outbound numbers. */
async function callerNumber(workspace: Workspace, e164: string | null): Promise<PhoneNumber | null> {
  if (!e164) return null;
  return (await outboundNumbers(workspace.id)).find((n) => n.e164 === e164) ?? null;
}

export async function updateOutboundSettings(workspace: Workspace, settings: OutboundSettings) {
  if (settings.retell_phone_number && !(await callerNumber(workspace, settings.retell_phone_number))) {
    throw new OutboundError('Choose one of this workspace’s phone numbers that can make outbound calls', 400);
  }
  await getOrProvisionAgentConfig(workspace);
  const { data, error } = await db()
    .from('va_agent_configs')
    .update({ ...settings, updated_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .select('retell_phone_number, outbound_begin_message')
    .single();
  if (error) throw new Error(`Failed to save outbound settings: ${error.message}`);
  return data as OutboundSettings;
}

/** Places an outbound phone call with the configured agent and logs it. */
export async function startOutboundCall(
  workspace: Workspace,
  input: { toNumber: string; customerName: string; reason: string; initiatedBy: string }
): Promise<CallLog> {
  const toNumber = normalizePhoneNumber(input.toNumber);
  if (!toNumber) {
    throw new OutboundError('Enter a valid Philippine (+63 / 09…) or US (+1) phone number', 400);
  }

  await assertOutboundAllowed(workspace);
  const trialLimitMs = await callLimitMs(workspace);
  const config = await getOrProvisionAgentConfig(workspace);
  const from = await callerNumber(workspace, config.retell_phone_number);
  if (!from) throw new OutboundError('Choose an outbound caller ID number first', 400);
  const country = countryOf(toNumber);
  // +1 covers the US and Canada
  const allowed = country === 'US' ? from.outbound_countries.some((c) => c === 'US' || c === 'CA') : from.outbound_countries.includes(country ?? '');
  if (!allowed) {
    throw new OutboundError(`${from.e164} can’t call ${country === 'PH' ? 'Philippine' : 'that country’s'} numbers. Use another caller ID.`, 400);
  }

  const vars = {
    customer_name: input.customerName,
    reason: input.reason,
    agent_name: config.agent_name,
  };

  const call = await getRetell().call.createPhoneCall({
    from_number: from.e164,
    to_number: toNumber,
    override_agent_id: config.retell_agent_id,
    // Callers hear the published version, never the studio draft
    ...(config.live_version !== null && { override_agent_version: config.live_version }),
    retell_llm_dynamic_variables: { ...vars, call_direction: 'outbound' },
    agent_override: {
      retell_llm: { begin_message: renderGreeting(config.outbound_begin_message, vars), start_speaker: 'agent' },
      agent: {
        max_call_duration_ms: Math.min(MAX_CALL_DURATION_MS, trialLimitMs ?? MAX_CALL_DURATION_MS),
        voicemail_option: { action: { type: 'hangup' } },
        post_call_analysis_data: ANALYSIS_FIELDS,
      },
    },
    metadata: {
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      source: 'outbound',
      initiated_by: input.initiatedBy,
    },
  });

  try {
    return await insertCallLog({
      workspace_id: workspace.id,
      retell_call_id: call.call_id,
      direction: 'outbound',
      source: 'outbound',
      status: call.call_status,
      from_number: from.e164,
      to_number: toNumber,
      customer_name: input.customerName || null,
      reason: input.reason,
      initiated_by: input.initiatedBy,
    });
  } catch (err) {
    throw new Error(`Call started but ${err instanceof Error ? err.message.toLowerCase() : 'logging failed'}`);
  }
}
