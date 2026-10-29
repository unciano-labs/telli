'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Rocket } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { hasRole } from '@/lib/workspace-roles';

export type PublishBarProps = {
  publishedAt: string | null;
  pendingEdits: { summary: string; created_at: string }[];
  tests: { cases: number; status: 'none' | 'running' | 'stale' | 'passed' | 'failed'; failed: number };
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Draft vs live status for the studio, with Publish for owners and admins. */
export default function PublishBar({ publishedAt, pendingEdits, tests }: PublishBarProps) {
  const router = useRouter();
  const api = useWorkspaceApi();
  const { slug, role } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const pending = pendingEdits.length;
  const canPublish = hasRole(role, 'admin');
  const testWarning =
    tests.status === 'failed'
      ? `${tests.failed} test ${tests.failed === 1 ? 'case' : 'cases'} failed on this draft.`
      : tests.status === 'stale'
        ? 'The draft changed since the tests last ran.'
        : tests.status === 'running'
          ? 'Tests are still running.'
          : tests.cases === 0
            ? 'You have no test cases yet.'
            : null;

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`${api}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Publish failed');
      setOpen(false);
      setNote('');
      setDone(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section
      aria-label="Publish status"
      className={`rounded-2xl p-4 ring-1 ${pending ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-200'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 text-sm">
          {pending ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 font-semibold text-amber-900"
              aria-expanded={open}
            >
              {pending} unpublished {pending === 1 ? 'change' : 'changes'}
              <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {done ? 'Published. Callers hear this version now.' : 'Callers hear the latest version'}
            </span>
          )}
          <p className="mt-0.5 text-slate-600">
            {publishedAt ? `Live version published ${formatWhen(publishedAt)}.` : 'Not published yet.'} Knowledge (FAQs, web
            pages, files) applies right away; profile, prompt and voice changes wait for Publish.
          </p>
        </div>
        {pending > 0 && (
          <Link
            href={`/w/${slug}/test`}
            className="rounded-full px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-white"
          >
            Test draft
          </Link>
        )}
        {pending > 0 && canPublish && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            <Rocket className="h-4 w-4" /> Publish
          </button>
        )}
      </div>

      {open && pending > 0 && (
        <div className="mt-4 border-t border-amber-200 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Changes in this draft</p>
          <ul className="mt-2 space-y-1 text-sm text-amber-950">
            {pendingEdits.map((e, i) => (
              <li key={i}>
                • {e.summary} <span className="text-amber-700">· {formatWhen(e.created_at)}</span>
              </li>
            ))}
          </ul>
          {canPublish && (
            <div className="mt-4 space-y-3">
              {testWarning && (
                <p className="flex items-start gap-2 rounded-xl bg-white/70 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {testWarning}{' '}
                    <Link href={`/w/${slug}/test`} className="font-medium underline">
                      Run tests first
                    </Link>{' '}
                    or publish anyway.
                  </span>
                </p>
              )}
              <label className="block text-sm font-medium text-slate-800">
                What changed? <span className="font-normal text-slate-500">(optional, shown in History)</span>
                <input
                  value={note}
                  maxLength={200}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. New prices and Saturday hours"
                  className="mt-1 block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-600"
                />
              </label>
              {error && (
                <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={publish}
                  disabled={publishing}
                  className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                >
                  {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  Publish to callers
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-full px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
