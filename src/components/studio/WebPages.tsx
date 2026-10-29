'use client';

import { useState } from 'react';
import { ExternalLink, Globe, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

export type KbSummaryView = {
  status: string;
  autoRefresh: boolean;
  lastRefreshedAt: string | null;
  pages: { sourceId: string; url: string }[];
};

/** Web pages the agent learns from (pricing, FAQ, policies). */
export default function WebPages({ initial }: { initial: KbSummaryView }) {
  const api = useWorkspaceApi();
  const [summary, setSummary] = useState(initial);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(method: 'POST' | 'PATCH' | 'DELETE', sourceId?: string) {
    setBusy(sourceId ?? 'new');
    setError(null);
    try {
      const res = await fetch(sourceId ? `${api}/pages?sourceId=${encodeURIComponent(sourceId)}` : `${api}/pages`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({ url }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
      setSummary(data.summary);
      if (method === 'POST') setUrl('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="pages-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 id="pages-heading" className="text-base font-semibold text-slate-900">
        Web pages
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Import your pricing, FAQ or policy pages.{' '}
        {summary.autoRefresh
          ? `They’re re-read daily${summary.lastRefreshedAt ? `, last on ${new Date(summary.lastRefreshedAt).toLocaleDateString()}` : ''}.`
          : 'Use Refresh after you change a page.'}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) send('POST');
        }}
        className="mt-4 flex gap-2"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://yourbusiness.com/pricing"
          aria-label="Web page address"
          className="block w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600"
        />
        <button
          disabled={!url.trim() || busy === 'new'}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Import
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {summary.pages.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100">
          {summary.pages.map((p) => (
            <li key={p.sourceId} className="flex items-center gap-3 py-2.5 text-sm">
              <Globe className="h-4 w-4 shrink-0 text-slate-400" />
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-slate-800 hover:text-indigo-600"
              >
                <span className="truncate">{p.url}</span> <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              <button
                type="button"
                onClick={() => send('PATCH', p.sourceId)}
                disabled={busy !== null}
                aria-label={`Refresh ${p.url}`}
                title="Re-read this page now"
                className="rounded p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-40"
              >
                <RefreshCw className={`h-4 w-4 ${busy === p.sourceId ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => send('DELETE', p.sourceId)}
                disabled={busy !== null}
                aria-label={`Remove ${p.url}`}
                className="rounded p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {summary.status === 'in_progress' || summary.status === 'refreshing_in_progress' ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading your knowledge… new pages are live in a minute or two.
        </p>
      ) : null}
    </section>
  );
}
