import 'server-only';
import type { CallResponse } from 'retell-sdk/resources/call';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { findAgentConfig, findAgentConfigByAgentId, publicWebhookUrl } from '@/lib/agent-config';
import { parseIntent, parseResolved, parseUnansweredQuestions, type CallerIntent } from '@/lib/call-analysis';

export type CallSource = 'landing' | 'widget' | 'demo' | 'test' | 'outbound' | 'inbound';
export type CallStatus = 'registered' | 'not_connected' | 'ongoing' | 'ended' | 'error';

export type CallLog = {
  id: string;
  workspace_id: string;
  retell_call_id: string;
  direction: 'outbound' | 'inbound' | 'web';
  source: CallSource;
  widget_id: string | null;
  page_url: string | null;
  visitor_id: string | null;
  user_id: string | null;
  from_number: string | null;
  to_number: string | null;
  customer_name: string | null;
  reason: string | null;
  initiated_by: string | null;
  status: CallStatus;
  disconnection_reason: string | null;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  cost_cents: number | null;
  user_sentiment: string | null;
  call_successful: boolean | null;
  summary: string | null;
  transcript: string | null;
  /** Retell's custom analysis (resolved, unanswered_questions, caller_intent). */
  analysis: Record<string, unknown> | null;
  resolved: boolean | null;
  caller_intent: CallerIntent | null;
  feedback_rating: 'up' | 'down' | null;
  feedback_comment: string | null;
  reviewed_at: string | null;
  created_at: string;
};

export type NewCallLog = Pick<CallLog, 'workspace_id' | 'retell_call_id' | 'direction' | 'source' | 'status'> &
  Partial<
    Pick<
      CallLog,
      | 'widget_id'
      | 'page_url'
      | 'visitor_id'
      | 'user_id'
      | 'from_number'
      | 'to_number'
      | 'customer_name'
      | 'reason'
      | 'initiated_by'
    >
  >;

// A call only moves forward; out-of-order webhooks must not reopen a finished call
const STATUS_RANK: Record<CallStatus, number> = {
  registered: 0,
  ongoing: 1,
  ended: 2,
  not_connected: 2,
  error: 2,
};

/** Admin test calls and demo sandbox calls: not real callers, so not used to improve the agent. */
export const PRACTICE_SOURCES: CallSource[] = ['test', 'demo'];

// Stop asking Retell about calls that never reported an end
const STALE_AFTER_MS = 30 * 60 * 1000;

function db() {
  return createAdminClient();
}

export function normalizeCallLog(row: CallLog): CallLog {
  // numeric columns come back from PostgREST as strings
  return { ...row, cost_cents: row.cost_cents == null ? null : Number(row.cost_cents) };
}

function isoOrUndefined(ms: number | undefined) {
  return ms ? new Date(ms).toISOString() : undefined;
}

/** Maps a Retell call to log columns, leaving out fields Retell hasn't sent yet. */
function fromRetell(call: CallResponse): Partial<CallLog> {
  const fields: Partial<CallLog> = {
    status: call.call_status,
    disconnection_reason: call.disconnection_reason,
    duration_ms: call.duration_ms,
    started_at: isoOrUndefined(call.start_timestamp),
    ended_at: isoOrUndefined(call.end_timestamp),
    cost_cents: call.call_cost?.combined_cost,
    transcript: call.transcript,
    summary: call.call_analysis?.call_summary,
    user_sentiment: call.call_analysis?.user_sentiment,
    call_successful: call.call_analysis?.call_successful,
  };
  const analysis = call.call_analysis?.custom_analysis_data as Record<string, unknown> | undefined;
  if (analysis) {
    fields.analysis = analysis;
    fields.resolved = parseResolved(analysis.resolved);
    fields.caller_intent = parseIntent(analysis.caller_intent);
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

export async function insertCallLog(row: NewCallLog): Promise<CallLog> {
  const { data, error } = await db()
    .from('va_call_logs')
    .insert({ website_id: WEBSITE_ID, ...row })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to log call: ${error.message}`);
  return normalizeCallLog(data as CallLog);
}

/**
 * Applies a Retell call snapshot (from a webhook or a retrieve) to its log row.
 * Inbound calls to one of our workspaces' agents are logged on first sight, under that
 * workspace; other unknown calls are ignored. Returns the updated row, or null if the call isn't ours.
 */
export async function applyRetellCall(call: CallResponse): Promise<CallLog | null> {
  const { data: existing, error } = await db()
    .from('va_call_logs')
    .select('id, status')
    .eq('website_id', WEBSITE_ID)
    .eq('retell_call_id', call.call_id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load call: ${error.message}`);

  const patch = fromRetell(call);

  if (!existing) {
    if (call.call_type !== 'phone_call' || call.direction !== 'inbound' || !call.agent_id) return null;
    const config = await findAgentConfigByAgentId(call.agent_id);
    if (!config) return null;
    const inserted = await insertCallLog({
      workspace_id: config.workspace_id,
      retell_call_id: call.call_id,
      direction: 'inbound',
      source: 'inbound',
      status: call.call_status,
      from_number: call.from_number,
      to_number: call.to_number,
    });
    const updated = await applyPatch(inserted.id, patch);
    if (patch.analysis) await recordUnansweredQuestions(updated);
    return updated;
  }

  if (patch.status && STATUS_RANK[patch.status] < STATUS_RANK[existing.status as CallStatus]) {
    delete patch.status;
  }
  const updated = await applyPatch(existing.id, patch);
  if (patch.analysis) await recordUnansweredQuestions(updated);
  return updated;
}

/**
 * Adds the questions the agent couldn't answer to the workspace's inbox. Safe to repeat:
 * webhooks and refreshes can deliver the same analysis more than once.
 */
async function recordUnansweredQuestions(log: CallLog) {
  if (PRACTICE_SOURCES.includes(log.source)) return;
  const questions = parseUnansweredQuestions(log.analysis?.unanswered_questions);
  if (!questions.length) return;
  const { error } = await db()
    .from('va_agent_questions')
    .upsert(
      questions.map((question) => ({
        website_id: WEBSITE_ID,
        workspace_id: log.workspace_id,
        call_log_id: log.id,
        question,
      })),
      { onConflict: 'call_log_id,question', ignoreDuplicates: true }
    );
  if (error) console.error('[call-logs] failed to record unanswered questions', log.retell_call_id, error.message);
}

async function applyPatch(id: string, patch: Partial<CallLog>): Promise<CallLog> {
  const { data, error } = await db()
    .from('va_call_logs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to update call: ${error.message}`);
  return normalizeCallLog(data as CallLog);
}

function needsRefresh(log: CallLog, now: number) {
  if (now - new Date(log.created_at).getTime() >= STALE_AFTER_MS) return false;
  if (log.status === 'registered' || log.status === 'ongoing') return true;
  // Retell analyzes calls shortly after hang-up; keep checking until the summary lands
  return log.status === 'ended' && !log.summary;
}

/** Re-reads unfinished calls from Retell (when webhooks can't reach us). Returns refreshed rows by id. */
async function refreshFromRetell(logs: CallLog[]): Promise<Map<string, CallLog>> {
  const retell = getRetell();
  const refreshed = await Promise.all(
    logs.map(async (log) => {
      try {
        return await applyRetellCall(await retell.call.retrieve(log.retell_call_id));
      } catch (err) {
        console.error('[call-logs] failed to refresh call', log.retell_call_id, err);
        return null;
      }
    })
  );
  return new Map(refreshed.filter((r): r is CallLog => r !== null).map((r) => [r.id, r]));
}

/** The given calls, with unfinished or unanalyzed recent ones re-read from Retell. */
export async function withFreshCalls(logs: CallLog[]): Promise<CallLog[]> {
  const now = Date.now();
  const stale = logs.filter((l) => needsRefresh(l, now));
  if (!stale.length) return logs;
  const byId = await refreshFromRetell(stale);
  return logs.map((l) => byId.get(l.id) ?? l);
}

const INBOUND_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Logs inbound phone calls Retell couldn't tell us about: without a public webhook URL
 * (local dev) nothing reports them, so recent ones are read from Retell instead.
 */
export async function syncInboundCalls(workspaceId: string): Promise<void> {
  if (publicWebhookUrl()) return;
  const { count } = await db()
    .from('va_phone_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .eq('inbound_enabled', true);
  if (!count) return;
  const config = await findAgentConfig(workspaceId);
  if (!config) return;

  const now = Date.now();
  const { items } = await getRetell().call.list({
    filter_criteria: {
      agent: [{ agent_id: config.retell_agent_id }],
      direction: { type: 'enum', op: 'in', value: ['inbound'] },
      start_timestamp: { type: 'range', op: 'bt', value: [now - INBOUND_LOOKBACK_MS, now] },
    },
    limit: 20,
  });
  if (!items.length) return;
  const { data: known } = await db()
    .from('va_call_logs')
    .select('retell_call_id, status, summary')
    .eq('website_id', WEBSITE_ID)
    .in('retell_call_id', items.map((c) => c.call_id));
  const done = new Set((known ?? []).filter((k) => k.status !== 'ongoing' && k.summary).map((k) => k.retell_call_id));
  for (const call of items) {
    if (!done.has(call.call_id)) await applyRetellCall(call as CallResponse);
  }
}

/** Brings a user's in-progress calls of one source up to date before allowances are computed (the demo). */
export async function refreshUnfinishedCalls(source: CallSource, userId: string): Promise<void> {
  const { data, error } = await db()
    .from('va_call_logs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('source', source)
    .eq('user_id', userId)
    .in('status', ['registered', 'ongoing'])
    .gte('created_at', new Date(Date.now() - STALE_AFTER_MS).toISOString());
  if (error) throw new Error(`Failed to load calls: ${error.message}`);
  if (data.length) await refreshFromRetell(data as CallLog[]);
}

/**
 * Lists a workspace's recent calls. The Retell webhook keeps rows current; as a fallback
 * (e.g. local dev, where Retell can't reach us) unfinished recent calls are refreshed from Retell.
 */
export async function listCallLogs({
  workspaceId,
  limit = 20,
  source,
}: {
  workspaceId: string;
  limit?: number;
  source?: CallSource;
}): Promise<CallLog[]> {
  if (!source || source === 'inbound') {
    await syncInboundCalls(workspaceId).catch((err) => console.error('[call-logs] inbound sync failed', err));
  }
  let query = db()
    .from('va_call_logs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (source) query = query.eq('source', source);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load calls: ${error.message}`);
  return withFreshCalls((data as CallLog[]).map(normalizeCallLog));
}

/** Number of a workspace's calls from one source (e.g. whether a test call was made). */
export async function countCalls(workspaceId: string, source: CallSource): Promise<number> {
  const { count, error } = await db()
    .from('va_call_logs')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('source', source);
  if (error) throw new Error(`Failed to count calls: ${error.message}`);
  return count ?? 0;
}
