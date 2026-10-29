'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Save, XCircle } from 'lucide-react';
import { MAX_VOICE_SPEED, MIN_VOICE_SPEED } from '@/lib/constants';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

export type VoiceOption = {
  id: string;
  name: string;
  provider: string;
  gender: string;
  accent?: string;
};

type Settings = {
  agent_name: string;
  voice_id: string;
  voice_speed: number;
  begin_message: string;
};

type Toast = { kind: 'success' | 'error'; text: string } | null;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

export default function AgentSettingsForm({
  initial,
  voices,
  updatedAt,
}: {
  initial: Settings;
  voices: VoiceOption[];
  updatedAt: string;
}) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [lastSaved, setLastSaved] = useState(updatedAt);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const voicesByProvider = useMemo(() => {
    const groups = new Map<string, VoiceOption[]>();
    for (const v of voices) groups.set(v.provider, [...(groups.get(v.provider) ?? []), v]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [voices]);
  const currentVoiceListed = voices.some((v) => v.id === form.voice_id);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setToast(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch(`${api}/agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      const next: Settings = {
        agent_name: data.config.agent_name,
        voice_id: data.config.voice_id,
        voice_speed: Number(data.config.voice_speed),
        begin_message: data.config.begin_message,
      };
      setSaved(next);
      setForm(next);
      setLastSaved(data.config.updated_at);
      setToast({ kind: 'success', text: 'Saved to the draft. Publish to make it live.' });
      router.refresh();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-base font-semibold text-slate-900">Voice and greeting</h2>
      <p className="mt-1 text-xs text-slate-400">Last saved {new Date(lastSaved).toLocaleString()}</p>

      <div className="mt-6 space-y-5">
        <label className="block text-sm font-medium text-slate-700">
          Agent name
          <input
            className={inputCls}
            value={form.agent_name}
            maxLength={100}
            required
            onChange={(e) => set('agent_name', e.target.value)}
          />
        </label>

        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Voice
            <select className={inputCls} value={form.voice_id} onChange={(e) => set('voice_id', e.target.value)}>
              {!currentVoiceListed && <option value={form.voice_id}>{form.voice_id}</option>}
              {voicesByProvider.map(([provider, list]) => (
                <optgroup key={provider} label={provider}>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {v.gender}
                      {v.accent ? ` · ${v.accent}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block text-sm font-medium text-slate-700">
            <span className="flex justify-between">
              Voice speed <span className="font-mono text-slate-500">{form.voice_speed.toFixed(1)}x</span>
            </span>
            <input
              type="range"
              min={MIN_VOICE_SPEED}
              max={MAX_VOICE_SPEED}
              step={0.1}
              value={form.voice_speed}
              onChange={(e) => set('voice_speed', Number(e.target.value))}
              className="mt-3 w-full accent-indigo-600"
            />
            <span className="flex justify-between text-xs font-normal text-slate-400">
              <span>{MIN_VOICE_SPEED}x</span>
              <span>{MAX_VOICE_SPEED}x</span>
            </span>
          </label>
        </div>

        <label className="block text-sm font-medium text-slate-700">
          Opening greeting
          <input
            className={inputCls}
            value={form.begin_message}
            required
            onChange={(e) => set('begin_message', e.target.value)}
          />
          <span className="mt-1 block text-xs font-normal text-slate-400">The first thing the agent says.</span>
        </label>

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
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
