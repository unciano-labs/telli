'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

export type FaqView = {
  id: string;
  question: string;
  alternates: string[];
  answer: string;
  status: 'syncing' | 'ready' | 'error';
  origin: 'manual' | 'correction' | 'unanswered';
};

type Draft = { question: string; alternates: string; answer: string };
const EMPTY: Draft = { question: '', alternates: '', answer: '' };
const POLL_MS = 5000;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

const ORIGIN_LABELS: Record<FaqView['origin'], string | null> = {
  manual: null,
  correction: 'from a call review',
  unanswered: 'from an unanswered question',
};

function StatusIcon({ status }: { status: FaqView['status'] }) {
  if (status === 'ready') return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Live" />;
  if (status === 'error') return <AlertCircle className="h-4 w-4 text-red-600" aria-label="Failed to sync" />;
  return <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-label="Adding to the knowledge base" />;
}

/** Question → answer pairs. Each is its own knowledge base entry and is live once synced. */
export default function FaqEditor({ initialFaqs }: { initialFaqs: FaqView[] }) {
  const api = useWorkspaceApi();
  const [faqs, setFaqs] = useState(initialFaqs);
  const [editing, setEditing] = useState<string | 'new' | null>(initialFaqs.length ? null : 'new');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`${api}/faqs`);
    if (res.ok) setFaqs((await res.json()).faqs);
  }, [api]);

  const syncing = faqs.some((f) => f.status === 'syncing');
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [syncing, refresh]);

  function startEdit(faq?: FaqView) {
    setError(null);
    setEditing(faq?.id ?? 'new');
    setDraft(faq ? { question: faq.question, alternates: faq.alternates.join('\n'), answer: faq.answer } : EMPTY);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const id = editing === 'new' ? null : editing;
    setBusy(id ?? 'new');
    setError(null);
    try {
      const res = await fetch(id ? `${api}/faqs?id=${id}` : `${api}/faqs`, {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: draft.question,
          answer: draft.answer,
          alternates: draft.alternates.split('\n').map((a) => a.trim()).filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setFaqs((list) => (id ? list.map((f) => (f.id === id ? data.faq : f)) : [data.faq, ...list]));
      setEditing(null);
      setDraft(EMPTY);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(faq: FaqView) {
    if (!window.confirm(`Delete the FAQ “${faq.question}”?`)) return;
    setBusy(faq.id);
    setError(null);
    try {
      const res = await fetch(`${api}/faqs?id=${faq.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Delete failed');
      setFaqs((list) => list.filter((f) => f.id !== faq.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const form = (
    <form onSubmit={save} className="space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <label className="block text-sm font-medium text-slate-700">
        Question
        <input
          className={inputCls}
          required
          maxLength={300}
          value={draft.question}
          onChange={(e) => setDraft((d) => ({ ...d, question: e.target.value }))}
          placeholder="Do you accept Maxicare?"
        />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Other ways people ask it <span className="font-normal text-slate-400">One per line, optional.</span>
        <textarea
          className={inputCls}
          rows={2}
          value={draft.alternates}
          onChange={(e) => setDraft((d) => ({ ...d, alternates: e.target.value }))}
          placeholder={'Is my HMO accepted?\nTumatanggap ba kayo ng HMO?'}
        />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Answer
        <textarea
          className={inputCls}
          rows={3}
          required
          maxLength={2000}
          value={draft.answer}
          onChange={(e) => setDraft((d) => ({ ...d, answer: e.target.value }))}
          placeholder="Yes. We accept Maxicare, Intellicare and MediCard. Bring your card and a valid ID."
        />
      </label>
      <div className="flex gap-2">
        <button
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save FAQ
        </button>
        <button
          type="button"
          onClick={() => setEditing(null)}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <section aria-labelledby="faq-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="faq-heading" className="text-base font-semibold text-slate-900">
            FAQs
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            The answers callers ask for most. Each one is live as soon as the check mark appears.
          </p>
        </div>
        {editing === null && (
          <button
            type="button"
            onClick={() => startEdit()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            <Plus className="h-4 w-4" /> Add FAQ
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {editing === 'new' && <div className="mt-4">{form}</div>}

      {faqs.length === 0 && editing === null && (
        <p className="mt-4 text-sm text-slate-500">No FAQs yet. Add the five questions you hear most.</p>
      )}
      <ul className="mt-4 space-y-3">
        {faqs.map((faq) =>
          editing === faq.id ? (
            <li key={faq.id}>{form}</li>
          ) : (
            <li key={faq.id} className="rounded-xl p-4 ring-1 ring-slate-200">
              <div className="flex items-start gap-3">
                <span className="mt-0.5">
                  <StatusIcon status={faq.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{faq.question}</p>
                  {faq.alternates.length > 0 && (
                    <p className="mt-0.5 text-xs text-slate-500">Also: {faq.alternates.join(' · ')}</p>
                  )}
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{faq.answer}</p>
                  {(ORIGIN_LABELS[faq.origin] || faq.status === 'error') && (
                    <p className="mt-2 text-xs text-slate-400">
                      {faq.status === 'error' ? (
                        <span className="text-red-600">Couldn’t add to the knowledge base. Edit and save to retry.</span>
                      ) : (
                        ORIGIN_LABELS[faq.origin]
                      )}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(faq)}
                    disabled={faq.status === 'syncing'}
                    aria-label={`Edit FAQ: ${faq.question}`}
                    className="rounded p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-40"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(faq)}
                    disabled={faq.status === 'syncing' || busy === faq.id}
                    aria-label={`Delete FAQ: ${faq.question}`}
                    className="rounded p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-40"
                  >
                    {busy === faq.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </li>
          )
        )}
      </ul>
    </section>
  );
}
