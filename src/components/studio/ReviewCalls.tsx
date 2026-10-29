'use client';

import { useState } from 'react';
import { Check, ChevronDown, CircleHelp, Flag, Frown, Loader2, ThumbsDown, ThumbsUp, XCircle } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { formatCallDuration, SOURCE_LABELS } from '@/components/admin/CallList';
import CorrectionForm, { type FixValues } from '@/components/studio/CorrectionForm';
import { CALLER_INTENTS, parseTranscript } from '@/lib/call-analysis';
import { hasRole } from '@/lib/workspace-roles';
import type { ReviewCall, ReviewFilter } from '@/lib/improve';

function Badge({ icon: Icon, label, cls }: { icon?: typeof Flag; label: string; cls: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {Icon && <Icon className="h-3 w-3" />}
      {label}
    </span>
  );
}

function callHeading(c: ReviewCall) {
  if (c.direction !== 'web') return `${SOURCE_LABELS[c.source]} · ${c.direction === 'inbound' ? c.from_number : c.to_number}`;
  if (!c.page_url) return SOURCE_LABELS[c.source];
  try {
    const u = new URL(c.page_url);
    return `${SOURCE_LABELS[c.source]} · ${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return SOURCE_LABELS[c.source];
  }
}

function CallBadges({ c }: { c: ReviewCall }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {c.feedback_rating === 'down' && <Badge icon={ThumbsDown} label="Caller: not helpful" cls="bg-red-50 text-red-700" />}
      {c.feedback_rating === 'up' && <Badge icon={ThumbsUp} label="Caller: helpful" cls="bg-emerald-50 text-emerald-700" />}
      {c.resolved === false && <Badge icon={XCircle} label="Not resolved" cls="bg-amber-50 text-amber-800" />}
      {c.unanswered.length > 0 && (
        <Badge icon={CircleHelp} label={`${c.unanswered.length} unanswered`} cls="bg-amber-50 text-amber-800" />
      )}
      {c.user_sentiment === 'Negative' && <Badge icon={Frown} label="Unhappy caller" cls="bg-slate-100 text-slate-700" />}
      {c.caller_intent && <Badge label={CALLER_INTENTS[c.caller_intent]} cls="bg-slate-100 text-slate-600" />}
      {c.reviewed_at && <Badge icon={Check} label="Reviewed" cls="bg-slate-100 text-slate-500" />}
    </div>
  );
}

/** A call's transcript; each agent reply can be marked as a wrong answer and fixed. */
function Transcript({ call, onFixed }: { call: ReviewCall; onFixed: (position: number) => void }) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const canApply = hasRole(role, 'admin');
  const [fixing, setFixing] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ position: number; text: string } | null>(null);
  const utterances = parseTranscript(call.transcript);

  async function save(position: number, values: FixValues) {
    const res = await fetch(`${api}/improve/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, call_log_id: call.id, position }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Couldn’t save the fix');
    setFixing(null);
    onFixed(position);
    setNotice({
      position,
      text: !canApply
        ? 'Suggestion sent. An owner or admin will review it.'
        : values.fix_type === 'faq'
          ? 'FAQ added. Callers get this answer once it’s indexed (about a minute).'
          : 'Rule added to the draft. Test it, then publish.',
    });
  }

  return (
    <ol className="space-y-2">
      {utterances.map((u, i) => {
        const fixed = call.fixed_positions.includes(i);
        const asked = utterances.slice(0, i).findLast((p) => p.role === 'user')?.content ?? '';
        return (
          <li key={i} className={`flex flex-col ${u.role === 'user' ? 'items-end' : 'items-start'}`}>
            <p
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 ${u.role === 'user' ? 'bg-indigo-600 text-white' : `bg-white text-slate-700 ring-1 ${fixed ? 'ring-emerald-300' : 'ring-slate-200'}`}`}
            >
              {u.content}
            </p>
            {u.role === 'agent' && fixing !== i && (
              <div className="mt-1 flex items-center gap-2 pl-1 text-xs">
                {fixed && (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                    <Check className="h-3 w-3" /> Fix saved
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setFixing(i);
                  }}
                  className="inline-flex items-center gap-1 font-medium text-slate-500 hover:text-red-700"
                >
                  <Flag className="h-3 w-3" /> Wrong answer
                </button>
              </div>
            )}
            {notice?.position === i && <p className="mt-1 pl-1 text-xs text-emerald-700">{notice.text}</p>}
            {fixing === i && (
              <div className="mt-2 w-full">
                <CorrectionForm
                  initial={{ fix_type: 'faq', question: asked.slice(0, 300), correction: '' }}
                  submitLabel={canApply ? 'Save fix' : 'Suggest fix'}
                  onSubmit={(values) => save(i, values)}
                  onCancel={() => setFixing(null)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Recent real calls, worst first: 👎 from the caller, unresolved, unanswered questions, unhappy callers. */
export default function ReviewCalls({ initialCalls, onCountChange }: { initialCalls: ReviewCall[]; onCountChange: (n: number) => void }) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const [filter, setFilter] = useState<ReviewFilter>('needs_review');
  const [calls, setCalls] = useState(initialCalls);
  const [expanded, setExpanded] = useState<string | null>(initialCalls[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(next: ReviewFilter) {
    setFilter(next);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${api}/improve/calls?filter=${next}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Couldn’t load calls');
      setCalls(data.calls);
      if (next === 'needs_review') onCountChange(data.calls.length);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function markReviewed(call: ReviewCall) {
    setError(null);
    const res = await fetch(`${api}/improve/calls?id=${call.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed: true }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Couldn’t update the call');
      return;
    }
    if (filter === 'needs_review') {
      const rest = calls.filter((c) => c.id !== call.id);
      setCalls(rest);
      onCountChange(rest.length);
      setExpanded(rest[0]?.id ?? null);
    } else {
      setCalls((list) => list.map((c) => (c.id === call.id ? { ...c, reviewed_at: new Date().toISOString() } : c)));
    }
  }

  function markFixed(callId: string, position: number) {
    setCalls((list) =>
      list.map((c) => (c.id === callId ? { ...c, fixed_positions: [...c.fixed_positions, position] } : c))
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Calls to show" className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
          {(
            [
              ['needs_review', 'Needs review'],
              ['all', 'All calls'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={filter === value}
              onClick={() => load(value)}
              className={`rounded-md px-3 py-1.5 transition ${filter === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        <p className="text-xs text-slate-400">Last 30 days · tests and demo calls excluded</p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {calls.length === 0 ? (
        <p className="rounded-xl bg-slate-50 py-8 text-center text-sm text-slate-500">
          {filter === 'needs_review'
            ? 'Nothing needs review. Calls rated 👎, unresolved, or with unanswered questions show up here.'
            : 'No calls with a transcript in the last 30 days.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-2xl bg-white ring-1 ring-slate-200">
          {calls.map((c) => {
            const open = expanded === c.id;
            return (
              <li key={c.id} className="p-4">
                <button type="button" onClick={() => setExpanded(open ? null : c.id)} className="flex w-full items-start gap-3 text-left">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="truncate text-sm font-medium text-slate-800">{callHeading(c)}</p>
                    <p className="text-xs text-slate-400">
                      {new Date(c.created_at).toLocaleString()}
                      {formatCallDuration(c.duration_ms) ? ` · ${formatCallDuration(c.duration_ms)}` : ''}
                    </p>
                    <CallBadges c={c} />
                  </div>
                  <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
                </button>

                {open && (
                  <div className="mt-4 space-y-4 rounded-xl bg-slate-50 p-4 text-sm">
                    {c.feedback_comment && (
                      <blockquote className="border-l-2 border-slate-300 pl-3 text-slate-700">
                        <span className="text-xs font-medium text-slate-500">Caller’s comment</span>
                        <p>{c.feedback_comment}</p>
                      </blockquote>
                    )}
                    {c.summary && <p className="text-slate-700">{c.summary}</p>}
                    {c.unanswered.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500">Questions the agent couldn’t answer</p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700">
                          {c.unanswered.map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <Transcript call={c} onFixed={(position) => markFixed(c.id, position)} />
                    {hasRole(role, 'admin') && !c.reviewed_at && (
                      <div className="flex justify-end border-t border-slate-200 pt-3">
                        <button
                          type="button"
                          onClick={() => markReviewed(c)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                        >
                          <Check className="h-4 w-4" /> Mark reviewed
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
