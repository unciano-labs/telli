'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, PhoneOutgoing, Save, XCircle } from 'lucide-react';
import CallList, { useCallList, type CallLogView } from '@/components/admin/CallList';
import { normalizePhoneNumber, OUTBOUND_COUNTRIES, renderGreeting } from '@/lib/constants';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

type Settings = { retell_phone_number: string | null; outbound_begin_message: string };
type Toast = { kind: 'success' | 'error'; text: string } | null;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

function Feedback({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return (
    <p
      role="status"
      className={`flex items-center gap-1.5 text-sm ${toast.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
    >
      {toast.kind === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
      {toast.text}
    </p>
  );
}

export default function OutboundCalls({
  agentName,
  numbers,
  initialSettings,
  initialCalls,
}: {
  agentName: string;
  numbers: { number: string; nickname: string | null }[];
  initialSettings: Settings;
  initialCalls: CallLogView[];
}) {
  const api = useWorkspaceApi();
  const [saved, setSaved] = useState(initialSettings);
  const [settings, setSettings] = useState(initialSettings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsToast, setSettingsToast] = useState<Toast>(null);

  const [toNumber, setToNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callToast, setCallToast] = useState<Toast>(null);

  const [calls, setCalls] = useCallList(initialCalls, 'outbound');

  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const normalized = normalizePhoneNumber(toNumber);
  const preview = renderGreeting(settings.outbound_begin_message, {
    customer_name: customerName || 'Maria',
    reason: reason || 'your recent order',
    agent_name: agentName,
  });

  async function saveSettings() {
    setSavingSettings(true);
    setSettingsToast(null);
    try {
      const res = await fetch(`${api}/outbound`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setSaved(data.settings);
      setSettings(data.settings);
      setSettingsToast({ kind: 'success', text: 'Outbound settings saved.' });
    } catch (err) {
      setSettingsToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSavingSettings(false);
    }
  }

  async function placeCall(e: React.FormEvent) {
    e.preventDefault();
    setCalling(true);
    setCallToast(null);
    try {
      const res = await fetch(`${api}/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toNumber, customerName, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not start the call');
      setCalls((list) => [data.call, ...list]);
      setCallToast({ kind: 'success', text: `Calling ${data.call.to_number}…` });
      setToNumber('');
      setCustomerName('');
      setReason('');
      setConsent(false);
    } catch (err) {
      setCallToast({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start the call' });
    } finally {
      setCalling(false);
    }
  }

  const callerIdMissing = !saved.retell_phone_number;

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <PhoneOutgoing className="h-4 w-4 text-indigo-600" /> Outbound calls
      </h2>
      <p className="mt-1 text-xs text-slate-400">
        The agent calls a phone number using the same voice, prompt and knowledge base. Allowed destinations:{' '}
        {OUTBOUND_COUNTRIES.map((c) => `${c.name} (${c.prefix})`).join(', ')}.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          {/* Settings */}
          <div className="space-y-4 rounded-xl bg-slate-50 p-4">
            <label className="block text-sm font-medium text-slate-700">
              Caller ID
              <select
                className={inputCls}
                value={settings.retell_phone_number ?? ''}
                onChange={(e) => {
                  setSettings((s) => ({ ...s, retell_phone_number: e.target.value || null }));
                  setSettingsToast(null);
                }}
              >
                <option value="">Select a number…</option>
                {numbers.map((n) => (
                  <option key={n.number} value={n.number}>
                    {n.number}
                    {n.nickname ? ` · ${n.nickname}` : ''}
                  </option>
                ))}
              </select>
              {numbers.length === 0 && (
                <span className="mt-1 block text-xs font-normal text-amber-700">
                  No numbers can make outbound calls. Add one or turn on outbound calling under Phone numbers.
                </span>
              )}
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Outbound greeting
              <textarea
                className={inputCls}
                rows={3}
                maxLength={500}
                value={settings.outbound_begin_message}
                onChange={(e) => {
                  setSettings((s) => ({ ...s, outbound_begin_message: e.target.value }));
                  setSettingsToast(null);
                }}
              />
              <span className="mt-1 block text-xs font-normal text-slate-400">
                Variables: {'{{customer_name}}'}, {'{{reason}}'}, {'{{agent_name}}'}
              </span>
            </label>
            <p className="rounded-lg bg-white px-3 py-2 text-sm italic text-slate-600 ring-1 ring-slate-200">
              “{preview}”
            </p>
            <div className="flex items-center justify-end gap-3">
              <Feedback toast={settingsToast} />
              <button
                type="button"
                onClick={saveSettings}
                disabled={!settingsDirty || savingSettings}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save settings
              </button>
            </div>
          </div>

          {/* Place a call */}
          <form onSubmit={placeCall} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium text-slate-700">
                Phone number
                <input
                  className={inputCls}
                  type="tel"
                  placeholder="0917 123 4567 or +1…"
                  value={toNumber}
                  required
                  onChange={(e) => setToNumber(e.target.value)}
                />
                <span className={`mt-1 block text-xs font-normal ${toNumber && !normalized ? 'text-red-600' : 'text-slate-400'}`}>
                  {toNumber ? (normalized ? `Will dial ${normalized}` : 'Not a valid PH or US number') : 'PH or US numbers'}
                </span>
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Contact name <span className="font-normal text-slate-400">(optional)</span>
                <input
                  className={inputCls}
                  value={customerName}
                  maxLength={80}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </label>
            </div>
            <label className="block text-sm font-medium text-slate-700">
              Reason for the call
              <input
                className={inputCls}
                placeholder="e.g. a follow-up on your support request"
                value={reason}
                maxLength={200}
                required
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-indigo-600"
              />
              This person has agreed to receive a call from an AI assistant.
            </label>
            <div className="flex items-center justify-end gap-3">
              <Feedback toast={callToast} />
              <button
                type="submit"
                disabled={calling || !consent || !normalized || !reason.trim() || callerIdMissing || settingsDirty}
                title={callerIdMissing ? 'Save a caller ID first' : settingsDirty ? 'Save settings first' : undefined}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {calling ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOutgoing className="h-4 w-4" />}
                {calling ? 'Starting…' : 'Call now'}
              </button>
            </div>
          </form>
        </div>

        {/* Recent calls */}
        <div>
          <h3 className="text-sm font-medium text-slate-700">Recent calls</h3>
          <div className="mt-3">
            <CallList calls={calls} />
          </div>
        </div>
      </div>
    </section>
  );
}
