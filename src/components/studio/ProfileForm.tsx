'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Save, XCircle } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import {
  buildPrompt,
  MAX_FIELD_CHARS,
  MAX_PROMPT_CHARS,
  TONES,
  type BusinessProfile,
  type PromptMode,
} from '@/lib/prompt';
import { TEMPLATES, type TemplateId } from '@/lib/templates';

type Toast = { kind: 'success' | 'error'; text: string } | null;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

const FIELDS: { key: keyof BusinessProfile; label: string; hint: string; rows: number; placeholder: string }[] = [
  { key: 'about', label: 'What you do', hint: 'One or two sentences.', rows: 2, placeholder: 'A family dental clinic in Makati, open since 2012.' },
  {
    key: 'services',
    label: 'Services and prices',
    hint: 'One per line.',
    rows: 5,
    placeholder: 'Cleaning: ₱1,200\nTooth-colored filling: from ₱1,500\nBraces: from ₱45,000, monthly plans available',
  },
  { key: 'hours', label: 'Opening hours', hint: '', rows: 2, placeholder: 'Mon–Sat 9 AM–6 PM. Closed Sundays and holidays.' },
  { key: 'location', label: 'Location and directions', hint: '', rows: 2, placeholder: '2nd floor, Ayala Tower, Ayala Ave, Makati. Parking at the basement.' },
  {
    key: 'policies',
    label: 'Policies',
    hint: 'Refunds, booking, cancellations, payment.',
    rows: 4,
    placeholder: 'Cancel at least 24 hours ahead. We accept GCash, cards and Maxicare.',
  },
  { key: 'avoid', label: 'Topics to avoid', hint: 'What the agent should not discuss.', rows: 2, placeholder: 'Competitor prices. Medical diagnoses.' },
  {
    key: 'handoff',
    label: 'When to hand off to a person',
    hint: 'And how callers reach your team.',
    rows: 2,
    placeholder: 'Complaints and insurance claims: take their name and number; the manager calls back within the day.',
  },
];

export default function ProfileForm({
  initialMode,
  initialProfile,
  initialCustomPrompt,
  agentName,
  rules,
}: {
  initialMode: PromptMode;
  initialProfile: BusinessProfile;
  initialCustomPrompt: string;
  agentName: string;
  rules: string[];
}) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const [saved, setSaved] = useState({ mode: initialMode, profile: initialProfile, custom: initialCustomPrompt });
  const [mode, setMode] = useState(initialMode);
  const [profile, setProfile] = useState(initialProfile);
  const [custom, setCustom] = useState(initialCustomPrompt);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [showPreview, setShowPreview] = useState(false);

  const dirty = JSON.stringify({ mode, profile, custom }) !== JSON.stringify(saved);
  const preview = buildPrompt({ mode, profile, customPrompt: custom, rules, agentName });

  function set<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
    setToast(null);
  }

  function switchMode(next: PromptMode) {
    // Starting Advanced from scratch is hard; seed it with what the profile produces
    if (next === 'advanced' && !custom.trim()) {
      const generated = buildPrompt({ mode: 'profile', profile, customPrompt: null, rules: [], agentName });
      setCustom(generated.slice(generated.indexOf('\n\n') + 2));
    }
    setMode(next);
    setToast(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch(`${api}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_mode: mode, profile, custom_prompt: custom }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setSaved({ mode, profile, custom });
      setToast({ kind: 'success', text: 'Saved to the draft. Test it, then publish.' });
      router.refresh();
    } catch (err) {
      setToast({ kind: 'error', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Business profile</h2>
          <p className="mt-1 text-sm text-slate-500">Fill this in and we write the agent’s instructions for you.</p>
        </div>
        <div role="radiogroup" aria-label="How to write the instructions" className="inline-flex rounded-full bg-slate-100 p-1 text-sm">
          {(['profile', 'advanced'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => switchMode(m)}
              className={`rounded-full px-3 py-1 font-medium transition ${mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {m === 'profile' ? 'Guided' : 'Advanced'}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Business name
            <input
              className={inputCls}
              value={profile.businessName}
              maxLength={80}
              required
              onChange={(e) => set('businessName', e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            What the agent does
            <select
              className={inputCls}
              value={profile.industry}
              onChange={(e) => set('industry', e.target.value as TemplateId)}
            >
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {mode === 'profile' ? (
          <>
            <fieldset>
              <legend className="text-sm font-medium text-slate-700">Tone</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {TONES.map((t) => (
                  <label
                    key={t.id}
                    className={`cursor-pointer rounded-full px-3 py-1.5 text-sm ring-1 transition ${profile.tone === t.id ? 'bg-indigo-50 text-indigo-700 ring-indigo-300' : 'text-slate-600 ring-slate-200 hover:bg-slate-50'}`}
                  >
                    <input
                      type="radio"
                      name="tone"
                      value={t.id}
                      checked={profile.tone === t.id}
                      onChange={() => set('tone', t.id)}
                      className="sr-only"
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
            {FIELDS.map((f) => (
              <label key={f.key} className="block text-sm font-medium text-slate-700">
                {f.label}
                {f.hint && <span className="ml-1 font-normal text-slate-400">{f.hint}</span>}
                <textarea
                  className={inputCls}
                  rows={f.rows}
                  maxLength={MAX_FIELD_CHARS}
                  placeholder={f.placeholder}
                  value={profile[f.key] as string}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </label>
            ))}
            <p className="text-xs text-slate-500">
              Longer details (full price lists, menus, policies) work best as FAQs, web pages or files under{' '}
              <span className="font-medium">Knowledge</span>.
            </p>
          </>
        ) : (
          <label className="block text-sm font-medium text-slate-700">
            Instructions
            <span className="ml-1 font-normal text-slate-400">
              Written by you. The platform’s safety rules and your team rules are added automatically.
            </span>
            <textarea
              className={`${inputCls} font-mono`}
              rows={16}
              maxLength={MAX_PROMPT_CHARS}
              value={custom}
              required
              onChange={(e) => {
                setCustom(e.target.value);
                setToast(null);
              }}
            />
            <span className="mt-1 block text-right text-xs font-normal tabular-nums text-slate-400">
              {custom.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
            </span>
          </label>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowPreview((s) => !s)}
            aria-expanded={showPreview}
            className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
          >
            {showPreview ? 'Hide' : 'Show'} the full instructions the agent gets
          </button>
          {showPreview && (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 font-mono text-xs text-slate-700 ring-1 ring-slate-200">
              {preview}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end gap-4">
        {toast && (
          <p
            role="status"
            className={`flex items-center gap-1.5 text-sm ${toast.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {toast.kind === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {toast.text}
          </p>
        )}
        <button
          type="submit"
          disabled={!dirty || saving}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving…' : 'Save to draft'}
        </button>
      </div>
    </form>
  );
}
