'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

export type RuleView = { id: string; rule: string; origin: 'manual' | 'correction' };

/** Short behavior rules added to the prompt, e.g. "Never quote delivery dates". */
export default function RulesEditor({ initialRules }: { initialRules: RuleView[] }) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const [rules, setRules] = useState(initialRules);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE', id?: string) {
    setBusy(id ?? 'new');
    setError(null);
    try {
      const res = await fetch(id ? `${api}/rules?id=${id}` : `${api}/rules`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({ rule: text }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
      setRules(data.rules);
      if (method === 'POST') setText('');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="rules-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 id="rules-heading" className="text-base font-semibold text-slate-900">
        Rules
      </h2>
      <p className="mt-1 text-sm text-slate-500">Things the agent must always or never do. Saved to the draft.</p>
      {rules.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100">
          {rules.map((r) => (
            <li key={r.id} className="flex items-start gap-3 py-2.5 text-sm">
              <span className="flex-1 text-slate-800">
                {r.rule}
                {r.origin === 'correction' && <span className="ml-2 text-xs text-slate-400">from a call review</span>}
              </span>
              <button
                type="button"
                onClick={() => send('DELETE', r.id)}
                disabled={busy === r.id}
                aria-label={`Remove rule: ${r.rule}`}
                className="text-slate-400 hover:text-red-600 disabled:opacity-50"
              >
                {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send('POST');
        }}
        className="mt-4 flex gap-2"
      >
        <input
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Never promise a delivery date"
          aria-label="New rule"
          className="block w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600"
        />
        <button
          disabled={!text.trim() || busy === 'new'}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
