'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import UsageChart from '@/components/admin/UsageChart';
import CallList, { SOURCE_LABELS, useCallList, type CallLogView } from '@/components/admin/CallList';

type AnalyticsData = {
  days: number;
  timezone: string;
  totals: { calls: number; connected: number; seconds: number; costCents: number };
  daily: { day: string; calls: number; seconds: number }[];
  bySource: { source: CallLogView['source']; calls: number; seconds: number }[];
  funnel: { loaded: number; opened: number; callStarted: number };
  topPages: { page: string; calls: number; seconds: number }[];
};

const RANGES = [7, 30, 90];

function minutes(seconds: number) {
  const m = seconds / 60;
  return m >= 100 ? Math.round(m).toLocaleString() : (Math.round(m * 10) / 10).toLocaleString();
}

function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '—';
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-400">{note}</p>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-sm font-medium text-slate-700">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Horizontal share bar; the label sits beside it in text ink, not in the bar color. */
function ShareRow({ label, value, share, detail }: { label: string; value: string; share: number; detail?: string }) {
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-slate-700">{label}</span>
        <span className="shrink-0 font-medium text-slate-900">
          {value}
          {detail && <span className="ml-1.5 text-xs font-normal text-slate-400">{detail}</span>}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-indigo-50">
        <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
      </div>
    </li>
  );
}

export default function AnalyticsView({
  data,
  widgets,
  widgetId,
  initialCalls,
}: {
  data: AnalyticsData;
  widgets: { id: string; name: string }[];
  widgetId: string | null;
  initialCalls: CallLogView[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [calls] = useCallList(initialCalls);

  function hrefWith(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  const { totals, funnel } = data;
  const avgSeconds = totals.connected ? totals.seconds / totals.connected : 0;
  const maxSourceCalls = Math.max(...data.bySource.map((s) => s.calls), 1);
  const maxPageCalls = Math.max(...data.topPages.map((p) => p.calls), 1);
  const funnelSteps = [
    { label: 'Saw the widget', value: funnel.loaded },
    { label: 'Opened it', value: funnel.opened },
    { label: 'Started a call', value: funnel.callStarted },
  ];

  return (
    <div className="space-y-6">
      {/* Filters: one row above the charts */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg bg-white p-0.5 text-sm font-medium shadow-sm ring-1 ring-slate-200">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={hrefWith({ range: String(r) })}
              aria-current={data.days === r ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 transition ${data.days === r ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:text-slate-900'}`}
            >
              {r} days
            </Link>
          ))}
        </div>
        <select
          aria-label="Widget"
          value={widgetId ?? ''}
          onChange={(e) => router.push(hrefWith({ widget: e.target.value || null }))}
          className="rounded-lg border-0 bg-white py-1.5 pl-3 pr-8 text-sm text-slate-700 shadow-sm ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-600"
        >
          <option value="">All calls</option>
          {widgets.map((w) => (
            <option key={w.id} value={w.id}>
              Widget: {w.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-400">Days in {data.timezone} · admin test calls excluded</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Calls" value={totals.calls.toLocaleString()} note={`${percent(totals.connected, totals.calls)} connected`} />
        <Stat label="Talk minutes" value={minutes(totals.seconds)} />
        <Stat
          label="Average call"
          value={avgSeconds ? `${Math.floor(avgSeconds / 60)}:${String(Math.round(avgSeconds % 60)).padStart(2, '0')}` : '—'}
          note="connected calls"
        />
        <Stat label="Retell cost" value={`$${(totals.costCents / 100).toFixed(2)}`} note="excludes Twilio charges" />
      </div>

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <UsageChart daily={data.daily} />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Widget funnel (unique visitors)">
          <ul>
            {funnelSteps.map((step, i) => (
              <ShareRow
                key={step.label}
                label={step.label}
                value={step.value.toLocaleString()}
                share={funnel.loaded ? step.value / funnel.loaded : 0}
                detail={i > 0 ? percent(step.value, funnelSteps[i - 1].value) : undefined}
              />
            ))}
          </ul>
          {funnel.loaded === 0 && <p className="mt-2 text-xs text-slate-400">No widget traffic in this period.</p>}
        </Card>

        <Card title="Calls by source">
          {data.bySource.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No calls in this period.</p>
          ) : (
            <ul>
              {data.bySource.map((s) => (
                <ShareRow
                  key={s.source}
                  label={SOURCE_LABELS[s.source]}
                  value={s.calls.toLocaleString()}
                  share={s.calls / maxSourceCalls}
                  detail={`${minutes(s.seconds)} min`}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Top pages (widget calls)">
          {data.topPages.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No widget calls in this period.</p>
          ) : (
            <ul>
              {data.topPages.map((p) => (
                <ShareRow
                  key={p.page}
                  label={p.page.replace(/^https?:\/\//, '')}
                  value={p.calls.toLocaleString()}
                  share={p.calls / maxPageCalls}
                  detail={`${minutes(p.seconds)} min`}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Recent calls">
        <CallList calls={calls} showSource />
      </Card>
    </div>
  );
}
