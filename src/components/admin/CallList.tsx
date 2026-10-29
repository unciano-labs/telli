'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

export type CallLogView = {
  id: string;
  direction: 'outbound' | 'inbound' | 'web';
  source: 'landing' | 'widget' | 'demo' | 'test' | 'outbound' | 'inbound';
  from_number: string | null;
  to_number: string | null;
  customer_name: string | null;
  reason: string | null;
  page_url: string | null;
  status: 'registered' | 'not_connected' | 'ongoing' | 'ended' | 'error';
  disconnection_reason: string | null;
  duration_ms: number | null;
  cost_cents: number | null;
  user_sentiment: string | null;
  summary: string | null;
  transcript: string | null;
  created_at: string;
};

const POLL_MS = 4000;
const SUMMARY_WAIT_MS = 5 * 60 * 1000;

const STATUS: Record<CallLogView['status'], { label: string; cls: string }> = {
  registered: { label: 'Waiting…', cls: 'bg-amber-50 text-amber-700' },
  ongoing: { label: 'In progress', cls: 'bg-emerald-50 text-emerald-700' },
  ended: { label: 'Ended', cls: 'bg-slate-100 text-slate-600' },
  not_connected: { label: 'Not connected', cls: 'bg-red-50 text-red-700' },
  error: { label: 'Error', cls: 'bg-red-50 text-red-700' },
};

export const SOURCE_LABELS: Record<CallLogView['source'], string> = {
  landing: 'Website dialer',
  widget: 'Widget',
  demo: 'Demo',
  test: 'Admin test',
  outbound: 'Outbound',
  inbound: 'Inbound',
};

function needsRefresh(c: CallLogView) {
  if (c.status === 'registered' || c.status === 'ongoing') return true;
  return c.status === 'ended' && !c.summary && Date.now() - new Date(c.created_at).getTime() < SUMMARY_WAIT_MS;
}

export function formatCallDuration(ms: number | null) {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function pagePath(url: string) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/** Call list state that polls while any call is unfinished or awaiting its summary. */
export function useCallList(initialCalls: CallLogView[], source?: CallLogView['source']) {
  const api = useWorkspaceApi();
  const [calls, setCalls] = useState(initialCalls);

  const refresh = useCallback(async () => {
    const query = source ? `?source=${source}` : '';
    const res = await fetch(`${api}/calls${query}`);
    if (res.ok) setCalls((await res.json()).calls);
  }, [api, source]);

  const polling = calls.some(needsRefresh);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  return [calls, setCalls] as const;
}

export default function CallList({ calls, showSource = false }: { calls: CallLogView[]; showSource?: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-slate-100">
      {calls.length === 0 && <li className="py-6 text-center text-sm text-slate-400">No calls yet.</li>}
      {calls.map((c) => {
        const s = STATUS[c.status];
        const open = expanded === c.id;
        const hasDetails = Boolean(c.summary || c.transcript || c.disconnection_reason);
        const phone = c.direction === 'inbound' ? c.from_number : c.to_number;
        const heading =
          c.direction === 'web' ? (
            <>
              {SOURCE_LABELS[c.source]}
              {c.page_url && <span className="font-normal text-slate-500"> · {pagePath(c.page_url)}</span>}
            </>
          ) : (
            <>
              {showSource && `${SOURCE_LABELS[c.source]} · `}
              {c.customer_name ? `${c.customer_name} · ` : ''}
              <span className="font-mono">{phone}</span>
            </>
          );
        return (
          <li key={c.id} className="py-3">
            <button
              type="button"
              onClick={() => setExpanded(open ? null : c.id)}
              disabled={!hasDetails}
              className="flex w-full items-center gap-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{heading}</p>
                <p className="truncate text-xs text-slate-400">
                  {new Date(c.created_at).toLocaleString()}
                  {formatCallDuration(c.duration_ms) ? ` · ${formatCallDuration(c.duration_ms)}` : ''}
                  {c.reason ? ` · ${c.reason}` : ''}
                </p>
              </div>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                {(c.status === 'registered' || c.status === 'ongoing') && <Loader2 className="h-3 w-3 animate-spin" />}
                {s.label}
              </span>
              {hasDetails && <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />}
            </button>
            {open && (
              <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3 text-sm">
                <p className="text-xs text-slate-500">
                  {c.disconnection_reason && (
                    <>
                      Ended by: <span className="font-medium">{c.disconnection_reason.replaceAll('_', ' ')}</span>
                    </>
                  )}
                  {c.user_sentiment && c.user_sentiment !== 'Unknown' && <> · Sentiment: {c.user_sentiment}</>}
                  {c.cost_cents != null && <> · Retell cost: ${(c.cost_cents / 100).toFixed(2)}</>}
                </p>
                {c.summary ? (
                  <p className="text-slate-700">{c.summary}</p>
                ) : (
                  c.status === 'ended' && <p className="text-xs text-slate-400">Summary is being generated…</p>
                )}
                {c.transcript && (
                  <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap font-sans text-xs text-slate-600">
                    {c.transcript}
                  </pre>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
