'use client';

import { useState } from 'react';
import { BookOpen, Loader2, ScrollText } from 'lucide-react';

export type FixValues = { fix_type: 'faq' | 'rule'; question: string; correction: string };

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

const FIX_TYPES = [
  {
    value: 'faq' as const,
    icon: BookOpen,
    label: 'Add an FAQ answer',
    hint: 'The agent didn’t know a fact. Live as soon as it’s added to the knowledge base.',
  },
  {
    value: 'rule' as const,
    icon: ScrollText,
    label: 'Add a rule',
    hint: 'The agent should behave differently. Goes into the draft; callers hear it after you publish.',
  },
];

/** How to fix a wrong or missing answer: an FAQ entry (a fact) or a prompt rule (a behavior). */
export default function CorrectionForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FixValues;
  submitLabel: string;
  onSubmit: (values: FixValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200">
      <fieldset>
        <legend className="font-medium text-slate-700">How should we fix it?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {FIX_TYPES.map(({ value, icon: Icon, label, hint }) => (
            <label
              key={value}
              className={`flex cursor-pointer gap-2.5 rounded-lg p-3 ring-1 transition ${values.fix_type === value ? 'bg-indigo-50 ring-indigo-300' : 'ring-slate-200 hover:bg-slate-50'}`}
            >
              <input
                type="radio"
                name="fix_type"
                value={value}
                checked={values.fix_type === value}
                onChange={() => setValues((v) => ({ ...v, fix_type: value }))}
                className="sr-only"
              />
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${values.fix_type === value ? 'text-indigo-600' : 'text-slate-400'}`} />
              <span>
                <span className="block font-medium text-slate-800">{label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {values.fix_type === 'faq' ? (
        <>
          <label className="block font-medium text-slate-700">
            Question
            <input
              className={inputCls}
              required
              maxLength={300}
              value={values.question}
              onChange={(e) => setValues((v) => ({ ...v, question: e.target.value }))}
              placeholder="Do you open on Sundays?"
            />
          </label>
          <label className="block font-medium text-slate-700">
            The right answer
            <textarea
              className={inputCls}
              rows={3}
              required
              maxLength={2000}
              value={values.correction}
              onChange={(e) => setValues((v) => ({ ...v, correction: e.target.value }))}
              placeholder="We’re closed on Sundays. We open Monday to Saturday, 9 AM to 6 PM."
            />
          </label>
        </>
      ) : (
        <label className="block font-medium text-slate-700">
          Rule for the agent
          <textarea
            className={inputCls}
            rows={2}
            required
            maxLength={500}
            value={values.correction}
            onChange={(e) => setValues((v) => ({ ...v, correction: e.target.value }))}
            placeholder="Never promise a delivery date. Say the team will confirm it by text."
          />
        </label>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </button>
      </div>
    </form>
  );
}
