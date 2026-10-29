'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import StatusBadge from '@/components/workspace/StatusBadge';
import { WORKSPACE_STATUSES, type WorkspaceStatus } from '@/lib/workspace-roles';

export type PlatformWorkspaceView = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  plan: string;
  current_period_end: string | null;
  is_platform: boolean;
  trial_seconds: number;
  created_at: string;
  owner_email: string | null;
  members: number;
  widgets: number;
  documents: number;
  calls: number;
  seconds: number;
  cost_cents: number;
  total_seconds: number;
};

type Toast = { kind: 'success' | 'error'; text: string } | null;

const STATUS_LABELS: Record<WorkspaceStatus, string> = { trial: 'Trial', active: 'Active', suspended: 'Suspended' };

function minutes(seconds: number) {
  return (seconds / 60).toFixed(1);
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PlatformWorkspaces({
  initial,
  days,
  plans,
}: {
  initial: PlatformWorkspaceView[];
  days: number;
  plans: { code: string; name: string }[];
}) {
  const planName = (code: string) => plans.find((p) => p.code === code)?.name ?? code;
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  async function update(row: PlatformWorkspaceView, body: { status?: WorkspaceStatus; trial_minutes?: number; grant_plan?: string }) {
    setBusy(row.id);
    setToast(null);
    try {
      const res = await fetch(`/api/platform/workspaces/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Update failed');
      setRows((list) =>
        list.map((r) =>
          r.id === row.id
            ? {
                ...r,
                status: data.workspace.status,
                plan: data.workspace.plan,
                trial_seconds: data.workspace.trial_seconds,
                current_period_end: data.workspace.current_period_end,
              }
            : r
        )
      );
      setToast({ kind: 'success', text: `${row.name} updated.` });
    } catch (error) {
      setToast({ kind: 'error', text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  function editTrial(row: PlatformWorkspaceView) {
    const value = window.prompt(`Free trial minutes for ${row.name}`, String(Math.round(row.trial_seconds / 60)));
    if (value === null) return;
    const trialMinutes = Number(value);
    if (!Number.isInteger(trialMinutes) || trialMinutes < 0) {
      setToast({ kind: 'error', text: 'Enter a whole number of minutes.' });
      return;
    }
    update(row, { trial_minutes: trialMinutes });
  }

  return (
    <div>
      {toast && (
        <p
          role="status"
          className={`mb-4 flex items-center gap-1.5 text-sm ${toast.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
        >
          {toast.kind === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {toast.text}
        </p>
      )}
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Workspaces with usage over the last {days} days</caption>
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3">Workspace</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3 text-right">Calls ({days}d)</th>
              <th scope="col" className="px-4 py-3 text-right">Minutes ({days}d)</th>
              <th scope="col" className="px-4 py-3 text-right">Cost ({days}d)</th>
              <th scope="col" className="px-4 py-3">Trial used</th>
              <th scope="col" className="px-4 py-3">Setup</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.id} className="align-top">
                <td className="px-4 py-3">
                  <Link href={`/w/${row.slug}`} className="font-medium text-indigo-600 hover:text-indigo-500">
                    {row.name}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {row.owner_email ?? 'no owner'} · since {new Date(row.created_at).toLocaleDateString()}
                  </p>
                </td>
                <td className="px-4 py-3">
                  {row.is_platform ? (
                    <StatusBadge status={row.status} />
                  ) : (
                    <select
                      aria-label={`Status for ${row.name}`}
                      value={row.status}
                      disabled={busy === row.id}
                      onChange={(e) => update(row, { status: e.target.value as WorkspaceStatus })}
                      className="rounded-lg border-0 py-1 pl-2 pr-7 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-600"
                    >
                      {WORKSPACE_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  )}
                  {!row.is_platform && (
                    <>
                      <p className="mt-1 text-xs text-slate-500">
                        {row.status === 'trial'
                          ? 'No plan yet'
                          : `${planName(row.plan)}${row.current_period_end ? ` · paid through ${new Date(row.current_period_end).toLocaleDateString()}` : ''}`}
                      </p>
                      <select
                        aria-label={`Grant a free month to ${row.name}`}
                        value=""
                        disabled={busy === row.id}
                        onChange={(e) => {
                          const code = e.target.value;
                          if (code && window.confirm(`Give ${row.name} one free month of ${planName(code)}?`)) update(row, { grant_plan: code });
                        }}
                        className="mt-1 rounded-lg border-0 py-0.5 pl-2 pr-7 text-xs text-slate-600 ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-600"
                      >
                        <option value="">Grant a month…</option>
                        {plans.map((p) => (
                          <option key={p.code} value={p.code}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{row.calls}</td>
                <td className="px-4 py-3 text-right tabular-nums">{minutes(row.seconds)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(row.cost_cents)}</td>
                <td className="px-4 py-3 tabular-nums">
                  {row.status === 'trial' ? (
                    <button
                      onClick={() => editTrial(row)}
                      disabled={busy === row.id}
                      className="text-left hover:text-indigo-600"
                      title="Change trial minutes"
                    >
                      {minutes(row.total_seconds)} of {Math.round(row.trial_seconds / 60)} min
                    </button>
                  ) : (
                    <span className="text-slate-400">n/a</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">
                  {row.documents} docs · {row.widgets} widgets · {row.members} members
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Calls, minutes and cost exclude test calls. Trial time counts every call, tests included.
      </p>
    </div>
  );
}
