import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { addRule } from '@/lib/agent-draft';
import { createFaq, validateFaq } from '@/lib/faqs';
import { ANALYTICS_TZ, dayKey, type Range } from '@/lib/analytics';
import { normalizeCallLog, PRACTICE_SOURCES, syncInboundCalls, withFreshCalls, type CallLog } from '@/lib/call-logs';
import {
  CALLER_INTENTS,
  groupSimilar,
  parseTranscript,
  parseUnansweredQuestions,
  type CallerIntent,
} from '@/lib/call-analysis';
import { hasRole, type WorkspaceRole } from '@/lib/workspace-roles';
import type { Workspace } from '@/lib/workspaces';

// Phase 4C: learn from real calls. Retell's post-call analysis feeds an inbox of questions
// the agent couldn't answer; wrong answers in transcripts become FAQ entries (live at once,
// like all knowledge) or rules (a draft edit, live after Publish).

export class ImproveError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_DAYS = 30;
const MAX_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function db() {
  return createAdminClient();
}

async function emailsFor(userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const emails = new Map<string, string>();
  if (!ids.length) return emails;
  const { data } = await db().from('user_profiles').select('user_id, email').in('user_id', ids);
  for (const p of data ?? []) emails.set(p.user_id, p.email);
  return emails;
}

export function validateIds(value: unknown): string[] {
  const ids = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
  if (!ids.length || ids.length > MAX_IDS || ids.some((id) => !UUID.test(id))) {
    throw new ImproveError('Choose at least one question', 400);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Unanswered questions inbox

export type QuestionGroup = {
  /** Open question rows in this group; actions apply to all of them. */
  ids: string[];
  /** The most common wording. */
  question: string;
  /** Other wordings callers used. */
  variants: string[];
  count: number;
  call_ids: string[];
  last_asked_at: string;
};

type QuestionRow = { id: string; question: string; call_log_id: string; created_at: string };

export async function listQuestionGroups(workspace: Workspace): Promise<QuestionGroup[]> {
  const { data, error } = await db()
    .from('va_agent_questions')
    .select('id, question, call_log_id, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`Failed to load questions: ${error.message}`);

  return groupSimilar(data as QuestionRow[])
    .map((rows) => {
      const wordings = new Map<string, { text: string; count: number }>();
      for (const r of rows) {
        const key = r.question.toLowerCase();
        const w = wordings.get(key) ?? { text: r.question, count: 0 };
        w.count++;
        wordings.set(key, w);
      }
      const [top, ...rest] = [...wordings.values()].sort(
        (a, b) => b.count - a.count || a.text.length - b.text.length
      );
      return {
        ids: rows.map((r) => r.id),
        question: top.text,
        variants: rest.slice(0, 5).map((w) => w.text),
        count: rows.length,
        call_ids: [...new Set(rows.map((r) => r.call_log_id))],
        last_asked_at: rows[0].created_at,
      };
    })
    .sort((a, b) => b.count - a.count || b.last_asked_at.localeCompare(a.last_asked_at));
}

async function openQuestions(workspace: Workspace, ids: string[]): Promise<QuestionRow[]> {
  const { data, error } = await db()
    .from('va_agent_questions')
    .select('id, question, call_log_id, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('status', 'open')
    .in('id', ids);
  if (error) throw new Error(`Failed to load questions: ${error.message}`);
  if (!data.length) throw new ImproveError('These questions were already handled', 409);
  return data as QuestionRow[];
}

async function closeQuestions(
  workspace: Workspace,
  userId: string,
  ids: string[],
  status: 'answered' | 'ignored',
  faqId: string | null = null
) {
  if (!ids.length) return;
  const { error } = await db()
    .from('va_agent_questions')
    .update({ status, faq_id: faqId, handled_by: userId, handled_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('status', 'open')
    .in('id', ids);
  if (error) throw new Error(`Failed to update questions: ${error.message}`);
}

export async function ignoreQuestions(workspace: Workspace, userId: string, ids: string[]) {
  const rows = await openQuestions(workspace, ids);
  await closeQuestions(workspace, userId, rows.map((r) => r.id), 'ignored');
}

export async function countOpenQuestions(workspaceId: string): Promise<number> {
  const { count, error } = await db()
    .from('va_agent_questions')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('status', 'open');
  if (error) throw new Error(`Failed to count questions: ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Corrections: fixes for wrong answers, and members' suggested answers

export type Correction = {
  id: string;
  call_log_id: string | null;
  position: number | null;
  caller_said: string | null;
  original_reply: string | null;
  fix_type: 'faq' | 'rule';
  question: string | null;
  correction: string;
  question_ids: string[];
  status: 'pending' | 'applied' | 'dismissed';
  created_by: string | null;
  created_by_email: string | null;
  reviewed_at: string | null;
  created_at: string;
};

export type CorrectionInput = {
  call_log_id: string | null;
  position: number | null;
  fix_type: Correction['fix_type'];
  question: string | null;
  correction: string;
  question_ids: string[];
};

const CORRECTION_COLUMNS =
  'id, call_log_id, position, caller_said, original_reply, fix_type, question, correction, question_ids, status, created_by, reviewed_at, created_at';

const MAX_RULE_CHARS = 500;
const MAX_ALTERNATE_CHARS = 200;
// The FAQ editor's limit
const MAX_ALTERNATES = 5;

export type FixInput = Pick<CorrectionInput, 'fix_type' | 'question' | 'correction'>;

/** The fix itself: an FAQ (question + answer) or a rule. */
export function validateFix(body: Record<string, unknown>): FixInput {
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');
  const correction = str('correction');
  if (body.fix_type === 'faq') {
    // Same limits as the FAQ editor
    const faq = validateFaq({ question: str('question'), answer: correction, alternates: [] });
    return { fix_type: 'faq', question: faq.question, correction: faq.answer };
  }
  if (body.fix_type !== 'rule') throw new ImproveError('Choose how to fix it: an FAQ entry or a rule', 400);
  if (!correction || correction.length > MAX_RULE_CHARS) {
    throw new ImproveError(`Write the rule in 1–${MAX_RULE_CHARS} characters`, 400);
  }
  return { fix_type: 'rule', question: null, correction };
}

/** A new fix: the fix plus what it's for (an agent reply in a call, or inbox questions). */
export function validateCorrection(body: Record<string, unknown>): CorrectionInput {
  const callLogId = typeof body.call_log_id === 'string' && UUID.test(body.call_log_id) ? body.call_log_id : null;
  const position = Number.isInteger(body.position) && (body.position as number) >= 0 ? (body.position as number) : null;
  const questionIds = body.question_ids === undefined ? [] : validateIds(body.question_ids);
  if (!callLogId && !questionIds.length) throw new ImproveError('A fix needs a call or an inbox question', 400);
  if (callLogId && position === null) throw new ImproveError('Choose the agent reply to fix', 400);
  return { ...validateFix(body), call_log_id: callLogId, position, question_ids: questionIds };
}

async function findCall(workspace: Workspace, callLogId: string): Promise<CallLog> {
  const { data, error } = await db()
    .from('va_call_logs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', callLogId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load call: ${error.message}`);
  if (!data) throw new ImproveError('Call not found', 404);
  return normalizeCallLog(data as CallLog);
}

/**
 * Saves a fix. Owners and admins apply it right away; a member's fix waits as a
 * suggestion until an owner or admin applies or dismisses it.
 */
export async function createCorrection(
  workspace: Workspace,
  userId: string,
  role: WorkspaceRole,
  input: CorrectionInput
): Promise<Correction> {
  let callerSaid: string | null = null;
  let originalReply: string | null = null;
  if (input.call_log_id) {
    const call = await findCall(workspace, input.call_log_id);
    const utterances = parseTranscript(call.transcript);
    const reply = utterances[input.position!];
    if (reply?.role !== 'agent') throw new ImproveError('That isn’t one of the agent’s replies', 400);
    originalReply = reply.content.slice(0, 4000);
    const asked = utterances.slice(0, input.position!).findLast((u) => u.role === 'user');
    callerSaid = asked?.content.slice(0, 2000) ?? null;
  }
  if (input.question_ids.length) await openQuestions(workspace, input.question_ids);

  const { data, error } = await db()
    .from('va_agent_corrections')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      call_log_id: input.call_log_id,
      position: input.position,
      caller_said: callerSaid,
      original_reply: originalReply,
      fix_type: input.fix_type,
      question: input.question,
      correction: input.correction,
      question_ids: input.question_ids,
      created_by: userId,
    })
    .select(CORRECTION_COLUMNS)
    .single();
  if (error) throw new Error(`Failed to save the fix: ${error.message}`);
  const saved = { ...(data as Omit<Correction, 'created_by_email'>), created_by_email: null };
  return hasRole(role, 'admin') ? applyCorrection(workspace, userId, saved.id) : saved;
}

/**
 * How callers actually asked it (the inbox wordings, or what the caller said before the
 * wrong reply), so the knowledge base matches the next caller who asks that way.
 */
async function alternateWordings(workspace: Workspace, fix: Pick<Correction, 'question' | 'caller_said' | 'question_ids'>) {
  let wordings = fix.caller_said ? [fix.caller_said] : [];
  if (fix.question_ids.length) {
    const { data } = await db()
      .from('va_agent_questions')
      .select('question')
      .eq('workspace_id', workspace.id)
      .in('id', fix.question_ids);
    wordings = (data ?? []).map((q) => q.question);
  }
  const seen = new Set([fix.question?.trim().toLowerCase()]);
  const alternates: string[] = [];
  for (const w of wordings.map((w) => w.trim())) {
    if (!w || w.length > MAX_ALTERNATE_CHARS || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    alternates.push(w);
  }
  return alternates.slice(0, MAX_ALTERNATES);
}

/**
 * Applies a pending fix: an FAQ entry (live once indexed) or a rule (a draft edit, live
 * after Publish). Owners and admins may edit it first.
 */
export async function applyCorrection(
  workspace: Workspace,
  userId: string,
  id: string,
  edits?: FixInput
): Promise<Correction> {
  // Claim it first so two reviewers can't apply the same fix twice
  const { data: claimed, error } = await db()
    .from('va_agent_corrections')
    .update({ status: 'applied', reviewed_by: userId, reviewed_at: new Date().toISOString(), ...edits })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .eq('status', 'pending')
    .select(CORRECTION_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`Failed to apply the fix: ${error.message}`);
  if (!claimed) throw new ImproveError('This fix was already handled', 409);
  const fix = claimed as Omit<Correction, 'created_by_email'>;

  try {
    if (fix.fix_type === 'faq') {
      const faq = await createFaq(
        workspace,
        userId,
        { question: fix.question!, answer: fix.correction, alternates: await alternateWordings(workspace, fix) },
        fix.question_ids.length ? 'unanswered' : 'correction'
      );
      await db().from('va_agent_corrections').update({ faq_id: faq.id }).eq('workspace_id', workspace.id).eq('id', id);
      await closeQuestions(workspace, userId, fix.question_ids, 'answered', faq.id);
    } else {
      await addRule(workspace, userId, fix.correction, 'correction');
      await closeQuestions(workspace, userId, fix.question_ids, 'answered');
    }
  } catch (err) {
    await db()
      .from('va_agent_corrections')
      .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
      .eq('workspace_id', workspace.id)
      .eq('id', id);
    throw err;
  }
  return { ...fix, created_by_email: null };
}

export async function dismissCorrection(workspace: Workspace, userId: string, id: string) {
  const { data, error } = await db()
    .from('va_agent_corrections')
    .update({ status: 'dismissed', reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(`Failed to dismiss the fix: ${error.message}`);
  if (!data.length) throw new ImproveError('This fix was already handled', 409);
}

/** Pending suggestions first, then the most recent fixes. */
export async function listCorrections(workspace: Workspace, limit = 100): Promise<Correction[]> {
  const { data, error } = await db()
    .from('va_agent_corrections')
    .select(CORRECTION_COLUMNS)
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load fixes: ${error.message}`);
  const rows = data as Omit<Correction, 'created_by_email'>[];
  const emails = await emailsFor(rows.map((r) => r.created_by));
  return rows
    .map((r) => ({ ...r, created_by_email: r.created_by ? (emails.get(r.created_by) ?? null) : null }))
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
}

// ---------------------------------------------------------------------------
// Review queue: real calls, worst first

export type ReviewFilter = 'needs_review' | 'all';

export type ReviewCall = Pick<
  CallLog,
  | 'id'
  | 'source'
  | 'direction'
  | 'page_url'
  | 'from_number'
  | 'to_number'
  | 'duration_ms'
  | 'user_sentiment'
  | 'summary'
  | 'transcript'
  | 'resolved'
  | 'caller_intent'
  | 'feedback_rating'
  | 'feedback_comment'
  | 'reviewed_at'
  | 'created_at'
> & {
  unanswered: string[];
  /** Transcript positions that already have a fix. */
  fixed_positions: number[];
};

function reviewPriority(c: ReviewCall) {
  if (c.feedback_rating === 'down') return 0;
  if (c.resolved === false) return 1;
  if (c.unanswered.length) return 2;
  if (c.user_sentiment === 'Negative') return 3;
  return 4;
}

function needsReview(c: ReviewCall) {
  return !c.reviewed_at && reviewPriority(c) < 4;
}

/** Recent ended calls with a transcript. "Needs review": 👎, unresolved, unanswered or negative, not yet reviewed. */
export async function listReviewCalls(workspace: Workspace, filter: ReviewFilter, limit = 50): Promise<ReviewCall[]> {
  await syncInboundCalls(workspace.id).catch((err) => console.error('[improve] inbound sync failed', err));
  const { data, error } = await db()
    .from('va_call_logs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .not('source', 'in', `(${PRACTICE_SOURCES.join(',')})`)
    .gte('created_at', new Date(Date.now() - REVIEW_DAYS * DAY_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw new Error(`Failed to load calls: ${error.message}`);
  const logs = (await withFreshCalls((data as CallLog[]).map(normalizeCallLog))).filter(
    (l) => l.status === 'ended' && l.transcript
  );

  const fixes = new Map<string, number[]>();
  if (logs.length) {
    const { data: rows } = await db()
      .from('va_agent_corrections')
      .select('call_log_id, position')
      .eq('workspace_id', workspace.id)
      .neq('status', 'dismissed')
      .in('call_log_id', logs.map((l) => l.id));
    for (const r of rows ?? []) {
      if (r.position !== null) fixes.set(r.call_log_id, [...(fixes.get(r.call_log_id) ?? []), r.position]);
    }
  }

  const calls: ReviewCall[] = logs.map((l) => ({
    id: l.id,
    source: l.source,
    direction: l.direction,
    page_url: l.page_url,
    from_number: l.from_number,
    to_number: l.to_number,
    duration_ms: l.duration_ms,
    user_sentiment: l.user_sentiment,
    summary: l.summary,
    transcript: l.transcript,
    resolved: l.resolved,
    caller_intent: l.caller_intent,
    feedback_rating: l.feedback_rating,
    feedback_comment: l.feedback_comment,
    reviewed_at: l.reviewed_at,
    created_at: l.created_at,
    unanswered: parseUnansweredQuestions(l.analysis?.unanswered_questions),
    fixed_positions: fixes.get(l.id) ?? [],
  }));
  if (filter === 'all') return calls.slice(0, limit);
  return calls
    .filter(needsReview)
    .sort((a, b) => reviewPriority(a) - reviewPriority(b) || b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export async function setCallReviewed(workspace: Workspace, userId: string, callLogId: string, reviewed: boolean) {
  const { data, error } = await db()
    .from('va_call_logs')
    .update(reviewed ? { reviewed_at: new Date().toISOString(), reviewed_by: userId } : { reviewed_at: null, reviewed_by: null })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', callLogId)
    .select('id');
  if (error) throw new Error(`Failed to update call: ${error.message}`);
  if (!data.length) throw new ImproveError('Call not found', 404);
}

// ---------------------------------------------------------------------------
// Caller feedback from the widget

const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;

/**
 * Records a widget caller's 👍 / 👎 on their call. Only the widget that started the call,
 * within an hour, and only once. Returns false when nothing matched.
 */
export async function recordCallFeedback(input: {
  widgetId: string;
  retellCallId: string;
  rating: 'up' | 'down';
  comment: string | null;
}): Promise<boolean> {
  const { data, error } = await db()
    .from('va_call_logs')
    .update({ feedback_rating: input.rating, feedback_comment: input.comment, feedback_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('widget_id', input.widgetId)
    .eq('retell_call_id', input.retellCallId)
    .is('feedback_rating', null)
    .gte('created_at', new Date(Date.now() - FEEDBACK_WINDOW_MS).toISOString())
    .select('id');
  if (error) throw new Error(`Failed to save feedback: ${error.message}`);
  return data.length > 0;
}

// ---------------------------------------------------------------------------
// Quality over time

export type QualityDay = {
  day: string;
  calls: number;
  /** Calls with Retell's analysis (resolved known). */
  analyzed: number;
  resolved: number;
  withUnanswered: number;
  up: number;
  down: number;
  seconds: number;
};

export type Quality = {
  days: Range;
  timezone: string;
  /** The whole range (day is empty). */
  totals: QualityDay;
  daily: QualityDay[];
  intents: { intent: CallerIntent; calls: number }[];
  publishes: { day: string; at: string; summary: string; action: 'publish' | 'rollback' }[];
  /** Resolved rate before and after the newest publish in the range. */
  lastPublish: { at: string; before: { analyzed: number; resolved: number }; after: { analyzed: number; resolved: number } } | null;
};

type QualityRow = Pick<CallLog, 'created_at' | 'duration_ms' | 'resolved' | 'analysis' | 'feedback_rating' | 'caller_intent'>;

function emptyDay(day: string): QualityDay {
  return { day, calls: 0, analyzed: 0, resolved: 0, withUnanswered: 0, up: 0, down: 0, seconds: 0 };
}

/** Connected real calls (no tests or demo) bucketed by day, with publish dates to compare against. */
export async function getQuality(workspace: Workspace, days: Range): Promise<Quality> {
  const now = Date.now();
  const dayList = Array.from({ length: days }, (_, i) => dayKey(new Date(now - (days - 1 - i) * DAY_MS)));
  const since = new Date(now - days * DAY_MS).toISOString();

  const [calls, changes] = await Promise.all([
    db()
      .from('va_call_logs')
      .select('created_at, duration_ms, resolved, analysis, feedback_rating, caller_intent')
      .eq('website_id', WEBSITE_ID)
      .eq('workspace_id', workspace.id)
      .not('source', 'in', `(${PRACTICE_SOURCES.join(',')})`)
      .gt('duration_ms', 0)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(5000),
    db()
      .from('va_agent_changes')
      .select('action, summary, created_at')
      .eq('website_id', WEBSITE_ID)
      .eq('workspace_id', workspace.id)
      .in('action', ['publish', 'rollback'])
      .gte('created_at', since)
      .order('created_at', { ascending: true }),
  ]);
  if (calls.error) throw new Error(`Failed to load call quality: ${calls.error.message}`);
  if (changes.error) throw new Error(`Failed to load publishes: ${changes.error.message}`);

  const daily = new Map(dayList.map((day) => [day, emptyDay(day)]));
  const totals = emptyDay('');
  const intents = new Map<CallerIntent, number>();
  const rows = calls.data as QualityRow[];
  for (const r of rows) {
    const d = daily.get(dayKey(new Date(r.created_at)));
    if (!d) continue;
    const unanswered = parseUnansweredQuestions(r.analysis?.unanswered_questions).length > 0;
    for (const t of [d, totals]) {
      t.calls++;
      t.seconds += Math.round((r.duration_ms ?? 0) / 1000);
      if (r.resolved !== null) {
        t.analyzed++;
        if (r.resolved) t.resolved++;
        if (unanswered) t.withUnanswered++;
      }
      if (r.feedback_rating === 'up') t.up++;
      if (r.feedback_rating === 'down') t.down++;
    }
    if (r.caller_intent && r.caller_intent in CALLER_INTENTS) {
      intents.set(r.caller_intent, (intents.get(r.caller_intent) ?? 0) + 1);
    }
  }

  const publishes = (changes.data as { action: 'publish' | 'rollback'; summary: string; created_at: string }[]).map((c) => ({
    day: dayKey(new Date(c.created_at)),
    at: c.created_at,
    summary: c.summary,
    action: c.action,
  }));

  let lastPublish: Quality['lastPublish'] = null;
  const latest = publishes.at(-1);
  if (latest) {
    const before = { analyzed: 0, resolved: 0 };
    const after = { analyzed: 0, resolved: 0 };
    for (const r of rows) {
      if (r.resolved === null) continue;
      const side = r.created_at >= latest.at ? after : before;
      side.analyzed++;
      if (r.resolved) side.resolved++;
    }
    lastPublish = { at: latest.at, before, after };
  }

  return {
    days,
    timezone: ANALYTICS_TZ,
    totals,
    daily: [...daily.values()],
    intents: [...intents].map(([intent, n]) => ({ intent, calls: n })).sort((a, b) => b.calls - a.calls),
    publishes,
    lastPublish,
  };
}
