'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Download, ExternalLink, Loader2, Save, XCircle } from 'lucide-react';
import { DEMO_SCENARIOS } from '@/lib/demo-config';

type Settings = {
  enabled: boolean;
  seconds_per_user: number;
  daily_budget_minutes: number;
  contact_url: string | null;
};

export type LeadView = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  joined_at: string;
  demo_calls: number;
  demo_seconds: number;
  scenarios: string[];
  last_demo_at: string | null;
};

type Toast = { kind: 'success' | 'error'; text: string } | null;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

const SCENARIO_NAMES: Record<string, string> = Object.fromEntries(DEMO_SCENARIOS.map((s) => [s.id, s.name]));

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function csvCell(value: string | number | null) {
  const text = value == null ? '' : String(value);
  // Quote everything; neutralize formulas when opened in a spreadsheet
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}

function downloadCsv(leads: LeadView[]) {
  const header = ['Name', 'Email', 'Role', 'Joined', 'Demo calls', 'Demo minutes', 'Scenarios', 'Last demo'];
  const rows = leads.map((l) => [
    l.full_name,
    l.email,
    l.role,
    l.joined_at,
    l.demo_calls,
    Math.round((l.demo_seconds / 60) * 10) / 10,
    l.scenarios.map((s) => SCENARIO_NAMES[s] ?? s).join('; '),
    l.last_demo_at,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `voice-agent-leads-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

export default function DemoAdmin({
  initialSettings,
  budget,
  leads,
  demoAgentId,
}: {
  initialSettings: Settings;
  budget: { budgetSeconds: number; usedSeconds: number };
  leads: LeadView[];
  demoAgentId: string | null;
}) {
  const [saved, setSaved] = useState(initialSettings);
  const [form, setForm] = useState({
    enabled: initialSettings.enabled,
    minutes: String(initialSettings.seconds_per_user / 60),
    budget: String(initialSettings.daily_budget_minutes),
    contact: initialSettings.contact_url ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [filter, setFilter] = useState<'all' | 'tried' | 'not_tried'>('all');

  const payload = {
    enabled: form.enabled,
    seconds_per_user: Math.round(Number(form.minutes) * 60),
    daily_budget_minutes: Number(form.budget),
    contact_url: form.contact.trim() || null,
  };
  const dirty = JSON.stringify(payload) !== JSON.stringify(saved);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setToast(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch('/api/platform/demo', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      const s: Settings = data.settings;
      setSaved({
        enabled: s.enabled,
        seconds_per_user: s.seconds_per_user,
        daily_budget_minutes: s.daily_budget_minutes,
        contact_url: s.contact_url,
      });
      setToast({ kind: 'success', text: 'Demo settings saved.' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  const budgetShare = budget.budgetSeconds ? Math.min(budget.usedSeconds / budget.budgetSeconds, 1) : 1;
  const tried = leads.filter((l) => l.demo_calls > 0).length;
  const shown = leads.filter((l) =>
    filter === 'all' ? true : filter === 'tried' ? l.demo_calls > 0 : l.demo_calls === 0
  );

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <form onSubmit={save} className="space-y-5 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">Settings</h2>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              Demo is live
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Free minutes per user
              <input
                type="number"
                min={0.5}
                max={60}
                step={0.5}
                className={inputCls}
                value={form.minutes}
                onChange={(e) => set('minutes', e.target.value)}
              />
              <span className="mt-1 block text-xs font-normal text-slate-400">Total across all their calls, not per day.</span>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Daily budget (minutes)
              <input
                type="number"
                min={0}
                step={1}
                className={inputCls}
                value={form.budget}
                onChange={(e) => set('budget', e.target.value)}
              />
              <span className="mt-1 block text-xs font-normal text-slate-400">
                All demo calls stop for the day once this is used.
              </span>
            </label>
          </div>
          <label className="block text-sm font-medium text-slate-700">
            “Talk to us” link <span className="font-normal text-slate-400">(optional)</span>
            <input
              className={inputCls}
              placeholder="https://calendly.com/you or mailto:sales@example.com"
              value={form.contact}
              onChange={(e) => set('contact', e.target.value)}
            />
            <span className="mt-1 block text-xs font-normal text-slate-400">
              Shown when someone uses up their free time. Leave empty to say you’ll email them.
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <Link href="/demo" target="_blank" className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-500">
              Open demo page <ExternalLink className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-3">
              {toast && (
                <p role="status" className={`flex items-center gap-1.5 text-sm ${toast.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>
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
                Save
              </button>
            </div>
          </div>
        </form>

        <section className="space-y-4">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-xs font-medium text-slate-500">Today’s demo budget</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
              {clock(budget.usedSeconds)}{' '}
              <span className="text-base font-normal text-slate-400">of {Math.round(budget.budgetSeconds / 60)} min</span>
            </p>
            <div className="mt-3 h-2 rounded-full bg-indigo-100">
              <div
                className={`h-2 rounded-full ${budgetShare >= 1 ? 'bg-red-600' : budgetShare > 0.8 ? 'bg-amber-500' : 'bg-indigo-600'}`}
                style={{ width: `${budgetShare * 100}%` }}
              />
            </div>
            {budgetShare >= 1 && <p className="mt-2 text-xs text-red-700">Budget reached: demo calls are paused until tomorrow.</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <p className="text-xs font-medium text-slate-500">Sign-ups</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{leads.length}</p>
            </div>
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <p className="text-xs font-medium text-slate-500">Tried the demo</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{tried}</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Scenario calls use a separate Retell agent{demoAgentId ? ` (${demoAgentId})` : ''}, so your own agent’s prompt
            is never changed. Demo calls show in Analytics under “Demo”.
          </p>
        </section>
      </div>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Leads</h2>
          <div className="flex items-center gap-3">
            <select
              aria-label="Filter leads"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              className="rounded-lg border-0 py-1.5 pl-3 pr-8 text-sm text-slate-700 ring-1 ring-inset ring-slate-300"
            >
              <option value="all">Everyone</option>
              <option value="tried">Tried the demo</option>
              <option value="not_tried">Signed up, no call yet</option>
            </select>
            <button
              onClick={() => downloadCsv(shown)}
              disabled={shown.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Person</th>
                <th className="py-2 pr-4 font-medium">Joined</th>
                <th className="py-2 pr-4 text-right font-medium">Demo time</th>
                <th className="py-2 pr-4 font-medium">Scenarios</th>
                <th className="py-2 font-medium">Last demo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    No one here yet.
                  </td>
                </tr>
              )}
              {shown.map((l) => (
                <tr key={l.user_id}>
                  <td className="py-2.5 pr-4">
                    <p className="font-medium text-slate-800">
                      {l.full_name || '—'}
                      {l.role === 'admin' && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">admin</span>}
                    </p>
                    <p className="text-xs text-slate-500">{l.email}</p>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-600">{new Date(l.joined_at).toLocaleDateString()}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-slate-800">
                    {l.demo_calls ? `${clock(l.demo_seconds)} · ${l.demo_calls} ${l.demo_calls === 1 ? 'call' : 'calls'}` : '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-600">
                    {l.scenarios.map((s) => SCENARIO_NAMES[s] ?? s).join(', ') || '—'}
                  </td>
                  <td className="py-2.5 text-slate-600">{l.last_demo_at ? new Date(l.last_demo_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
