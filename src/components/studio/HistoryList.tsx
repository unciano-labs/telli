'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Loader2, PencilLine, Rocket, Undo2 } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { hasRole } from '@/lib/workspace-roles';

export type ChangeView = {
  id: string;
  action: 'edit' | 'publish' | 'rollback';
  scope: 'draft' | 'live';
  version: number | null;
  summary: string;
  changed_by_email: string | null;
  created_at: string;
  can_restore: boolean;
};

function describe(c: ChangeView) {
  if (c.action === 'publish') return { icon: Rocket, label: 'Published', cls: 'bg-indigo-50 text-indigo-700' };
  if (c.action === 'rollback') return { icon: Undo2, label: 'Rolled back', cls: 'bg-violet-50 text-violet-700' };
  if (c.scope === 'live') return { icon: BookOpen, label: 'Knowledge', cls: 'bg-emerald-50 text-emerald-700' };
  return { icon: PencilLine, label: 'Draft edit', cls: 'bg-slate-100 text-slate-700' };
}

/** Who changed what and when; published versions can be made live again. */
export default function HistoryList({ initialChanges, liveVersion }: { initialChanges: ChangeView[]; liveVersion: number | null }) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const { role } = useWorkspace();
  const canRestore = hasRole(role, 'admin');
  const [changes, setChanges] = useState(initialChanges);
  const [live, setLive] = useState(liveVersion);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(change: ChangeView) {
    const ok = window.confirm(
      'Make this version live again? Callers hear it from their next call. Unpublished draft changes are discarded. FAQs, web pages and files stay as they are now.'
    );
    if (!ok) return;
    setBusy(change.id);
    setError(null);
    try {
      const res = await fetch(`${api}/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: change.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Rollback failed');
      setChanges(data.changes);
      setLive(data.changes.find((c: ChangeView) => c.action === 'rollback')?.version ?? live);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!changes.length) {
    return <p className="text-sm text-slate-500">No changes yet. Edits, publishes and rollbacks will show up here.</p>;
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <ol className="divide-y divide-slate-100 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        {changes.map((c) => {
          const { icon: Icon, label, cls } = describe(c);
          const isLive = (c.action === 'publish' || c.action === 'rollback') && c.version === live;
          return (
            <li key={c.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-900">{c.summary}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {new Date(c.created_at).toLocaleString()} · {c.changed_by_email ?? 'System'}
                </p>
              </div>
              {isLive ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">Live now</span>
              ) : (
                c.can_restore &&
                canRestore && (
                  <button
                    type="button"
                    onClick={() => restore(c)}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {busy === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                    Make live again
                  </button>
                )
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
