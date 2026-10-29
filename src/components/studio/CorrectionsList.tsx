'use client';

import { useState } from 'react';
import { BookOpen, Check, Loader2, ScrollText, X } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import CorrectionForm, { type FixValues } from '@/components/studio/CorrectionForm';
import { hasRole } from '@/lib/workspace-roles';
import type { Correction } from '@/lib/improve';

const STATUS: Record<Correction['status'], { label: string; cls: string }> = {
  pending: { label: 'Suggested', cls: 'bg-amber-50 text-amber-800' },
  applied: { label: 'Applied', cls: 'bg-emerald-50 text-emerald-700' },
  dismissed: { label: 'Dismissed', cls: 'bg-slate-100 text-slate-500' },
};

function FixSummary({ c }: { c: Correction }) {
  const Icon = c.fix_type === 'faq' ? BookOpen : ScrollText;
  return (
    <div className="flex gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true" />
      <div className="min-w-0 text-sm">
        {c.fix_type === 'faq' ? (
          <>
            <p className="font-medium text-slate-800">FAQ: {c.question}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-slate-600">{c.correction}</p>
          </>
        ) : (
          <p className="text-slate-800">
            <span className="font-medium">Rule:</span> {c.correction}
          </p>
        )}
      </div>
    </div>
  );
}

/** Fixes from call reviews and the inbox. Members' suggestions wait here for an owner or admin. */
export default function CorrectionsList({
  initialCorrections,
  onCountChange,
}: {
  initialCorrections: Correction[];
  onCountChange: (pending: number) => void;
}) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const canApply = hasRole(role, 'admin');
  const [items, setItems] = useState(initialCorrections);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update(id: string, status: Correction['status'], values?: FixValues) {
    const next = items.map((c) =>
      c.id === id ? { ...c, status, ...(values && { ...values, question: values.fix_type === 'faq' ? values.question : null }) } : c
    );
    setItems(next);
    onCountChange(next.filter((c) => c.status === 'pending').length);
  }

  async function apply(c: Correction, values: FixValues) {
    const res = await fetch(`${api}/improve/corrections?id=${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply', ...values }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Couldn’t apply the fix');
    setEditing(null);
    update(c.id, 'applied', values);
  }

  async function dismiss(c: Correction) {
    setBusy(c.id);
    setError(null);
    try {
      const res = await fetch(`${api}/improve/corrections?id=${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Couldn’t dismiss it');
      update(c.id, 'dismissed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!items.length) {
    return (
      <p className="rounded-xl bg-slate-50 py-8 text-center text-sm text-slate-500">
        No fixes yet. Mark a wrong answer in a call, or answer a question from the inbox.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {items.map((c) => {
          const s = STATUS[c.status];
          return (
            <li key={c.id} className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className={`rounded-full px-2 py-0.5 font-medium ${s.cls}`}>{s.label}</span>
                <span>
                  {c.created_by_email ?? 'Someone'} · {new Date(c.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  {c.question_ids.length > 0 ? ' · from the inbox' : c.call_log_id ? ' · from a call' : ''}
                </span>
              </div>

              {c.original_reply && (
                <div className="space-y-1 rounded-xl bg-slate-50 p-3 text-sm">
                  {c.caller_said && (
                    <p className="text-slate-600">
                      <span className="text-xs font-medium text-slate-400">Caller: </span>
                      {c.caller_said}
                    </p>
                  )}
                  <p className="text-slate-600">
                    <span className="text-xs font-medium text-slate-400">Agent (wrong): </span>
                    <span className="line-through decoration-red-300">{c.original_reply}</span>
                  </p>
                </div>
              )}

              {editing === c.id ? (
                <CorrectionForm
                  initial={{ fix_type: c.fix_type, question: c.question ?? c.caller_said?.slice(0, 300) ?? '', correction: c.correction }}
                  submitLabel="Apply fix"
                  onSubmit={(values) => apply(c, values)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <FixSummary c={c} />
              )}

              {c.status === 'pending' && canApply && editing !== c.id && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(c.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
                  >
                    <Check className="h-4 w-4" /> Review and apply
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(c)}
                    disabled={busy === c.id}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {busy === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    Dismiss
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
