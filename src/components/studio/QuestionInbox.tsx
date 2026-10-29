'use client';

import { useState } from 'react';
import { EyeOff, Loader2, MessageSquarePlus } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import CorrectionForm, { type FixValues } from '@/components/studio/CorrectionForm';
import { hasRole } from '@/lib/workspace-roles';
import type { QuestionGroup } from '@/lib/improve';

function key(group: QuestionGroup) {
  return group.ids[0];
}

/** Questions callers asked that the agent couldn't answer, grouped and sorted by how often. */
export default function QuestionInbox({
  initialGroups,
  onCountChange,
}: {
  initialGroups: QuestionGroup[];
  onCountChange: (n: number) => void;
}) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const canApply = hasRole(role, 'admin');
  const [groups, setGroups] = useState(initialGroups);
  const [answering, setAnswering] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function remove(group: QuestionGroup) {
    const rest = groups.filter((g) => key(g) !== key(group));
    setGroups(rest);
    onCountChange(rest.length);
  }

  async function answer(group: QuestionGroup, values: FixValues) {
    const res = await fetch(`${api}/improve/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, question_ids: group.ids }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Couldn’t save the answer');
    setAnswering(null);
    if (canApply) {
      remove(group);
      setNotice(
        values.fix_type === 'faq'
          ? `Added an FAQ for “${values.question}”. Callers get it once it’s indexed (about a minute).`
          : 'Rule added to the draft. Test it, then publish.'
      );
    } else {
      setNotice('Suggestion sent. An owner or admin will review it.');
    }
  }

  async function ignore(group: QuestionGroup) {
    setBusy(key(group));
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${api}/improve/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ignore', ids: group.ids }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Couldn’t ignore it');
      remove(group);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {groups.length === 0 ? (
        <p className="rounded-xl bg-slate-50 py-8 text-center text-sm text-slate-500">
          No unanswered questions. When callers ask something the agent can’t answer, it shows up here.
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={key(g)} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">{g.question}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Asked {g.count} {g.count === 1 ? 'time' : 'times'}
                    {g.call_ids.length !== g.count && ` in ${g.call_ids.length} calls`} · last{' '}
                    {new Date(g.last_asked_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </p>
                  {g.variants.length > 0 && (
                    <p className="mt-1.5 text-xs text-slate-500">Also asked as: {g.variants.map((v) => `“${v}”`).join(' · ')}</p>
                  )}
                </div>
                {answering !== key(g) && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        setAnswering(key(g));
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                      {canApply ? 'Add answer' : 'Suggest answer'}
                    </button>
                    {canApply && (
                      <button
                        type="button"
                        onClick={() => ignore(g)}
                        disabled={busy === key(g)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {busy === key(g) ? <Loader2 className="h-4 w-4 animate-spin" /> : <EyeOff className="h-4 w-4" />}
                        Ignore
                      </button>
                    )}
                  </div>
                )}
              </div>
              {answering === key(g) && (
                <div className="mt-3">
                  <CorrectionForm
                    initial={{ fix_type: 'faq', question: g.question, correction: '' }}
                    submitLabel={canApply ? 'Add answer' : 'Suggest answer'}
                    onSubmit={(values) => answer(g, values)}
                    onCancel={() => setAnswering(null)}
                  />
                  {g.variants.length > 0 && (
                    <p className="mt-2 text-xs text-slate-500">The other wordings are saved with the FAQ so the agent recognizes them too.</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
