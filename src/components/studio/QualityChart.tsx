'use client';

import { useState } from 'react';

export type QualityDayView = {
  day: string;
  calls: number;
  analyzed: number;
  resolved: number;
  withUnanswered: number;
  up: number;
  down: number;
  seconds: number;
};

export type PublishMarker = { day: string; at: string; summary: string; action: 'publish' | 'rollback' };

type Metric = 'resolved' | 'unanswered' | 'rating' | 'length';

const CHART_HEIGHT = 160;

/** Each measure: its value for a day (null when there's nothing to measure), axis and labels. */
const METRICS: Record<
  Metric,
  {
    label: string;
    title: string;
    value: (d: QualityDayView) => number | null;
    basis: (d: QualityDayView) => string;
    format: (v: number) => string;
    percent: boolean;
  }
> = {
  resolved: {
    label: 'Resolved',
    title: 'Calls resolved by the agent',
    value: (d) => (d.analyzed ? d.resolved / d.analyzed : null),
    basis: (d) => `${d.resolved} of ${d.analyzed} analyzed ${d.analyzed === 1 ? 'call' : 'calls'}`,
    format: (v) => `${Math.round(v * 100)}%`,
    percent: true,
  },
  unanswered: {
    label: 'Unanswered',
    title: 'Calls with a question the agent couldn’t answer',
    value: (d) => (d.analyzed ? d.withUnanswered / d.analyzed : null),
    basis: (d) => `${d.withUnanswered} of ${d.analyzed} analyzed ${d.analyzed === 1 ? 'call' : 'calls'}`,
    format: (v) => `${Math.round(v * 100)}%`,
    percent: true,
  },
  rating: {
    label: 'Caller 👍',
    title: 'Widget callers who rated the call 👍',
    value: (d) => (d.up + d.down ? d.up / (d.up + d.down) : null),
    basis: (d) => `${d.up} 👍 · ${d.down} 👎`,
    format: (v) => `${Math.round(v * 100)}%`,
    percent: true,
  },
  length: {
    label: 'Call length',
    title: 'Average call length',
    value: (d) => (d.calls ? d.seconds / d.calls : null),
    basis: (d) => `${d.calls} ${d.calls === 1 ? 'call' : 'calls'}`,
    format: (v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`,
    percent: false,
  },
};

/** Axis max: 100% for rates; for seconds, the next whole minute step. */
function axisMax(metric: Metric, values: (number | null)[]) {
  if (METRICS[metric].percent) return 1;
  const max = Math.max(...values.map((v) => v ?? 0), 0);
  const step = max <= 240 ? 60 : 120;
  return Math.max(step, Math.ceil(max / step) * step);
}

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions) {
  // Noon UTC keeps the calendar day stable in any viewer timezone
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
}

/**
 * Daily call quality, one measure at a time (they don't share a scale), with the days a
 * version was published marked so owners can see whether a change helped.
 */
export default function QualityChart({ daily, publishes }: { daily: QualityDayView[]; publishes: PublishMarker[] }) {
  const [metric, setMetric] = useState<Metric>('resolved');
  const [hover, setHover] = useState<number | null>(null);
  const m = METRICS[metric];

  const values = daily.map(m.value);
  const max = axisMax(metric, values);
  const ticks = Array.from({ length: 5 }, (_, i) => (max / 4) * i);
  const labelEvery = Math.max(1, Math.ceil(daily.length / 6));
  const publishedOn = new Map<string, PublishMarker[]>();
  for (const p of publishes) publishedOn.set(p.day, [...(publishedOn.get(p.day) ?? []), p]);

  return (
    <figure>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <figcaption className="text-sm font-medium text-slate-700">{m.title}, per day</figcaption>
        <div role="radiogroup" aria-label="Measure" className="flex flex-wrap rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
          {(Object.keys(METRICS) as Metric[]).map((key) => (
            <button
              key={key}
              role="radio"
              aria-checked={metric === key}
              onClick={() => setMetric(key)}
              className={`rounded-md px-2.5 py-1 transition ${metric === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {METRICS[key].label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex gap-2" aria-hidden="true">
        <div className="relative w-9 shrink-0 text-right text-[11px] text-slate-400" style={{ height: CHART_HEIGHT }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ bottom: `${(t / max) * 100}%` }}>
              {m.format(t)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: CHART_HEIGHT }}>
            {ticks.map((t) => (
              <div
                key={t}
                className={`absolute inset-x-0 h-px ${t === 0 ? 'bg-slate-300' : 'bg-slate-100'}`}
                style={{ bottom: `${(t / max) * 100}%` }}
              />
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
              {daily.map((d, i) => {
                const v = values[i];
                const active = hover === i;
                const published = publishedOn.get(d.day);
                return (
                  <div
                    key={d.day}
                    className="relative flex h-full flex-1 items-end justify-center"
                    onMouseEnter={() => setHover(i)}
                  >
                    {active && <div className="absolute inset-y-0 w-full rounded-sm bg-slate-100/70" />}
                    {published && (
                      <>
                        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-slate-500" />
                        <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-slate-700 ring-2 ring-white" />
                      </>
                    )}
                    <div
                      className={`relative w-full max-w-6 rounded-t transition-colors ${active ? 'bg-indigo-700' : 'bg-indigo-500'}`}
                      style={{ height: v !== null && v > 0 ? `max(${(v / max) * 100}%, 2px)` : 0 }}
                    />
                    {active && (
                      <div
                        className={`pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-64 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg ${i < daily.length / 2 ? 'left-0' : 'right-0'}`}
                      >
                        <p className="font-medium">{dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                        <p className="text-slate-300">
                          {v === null ? 'Nothing to measure' : `${m.format(v)} · ${m.basis(d)}`}
                        </p>
                        {published?.map((p) => (
                          <p key={p.at} className="mt-1 text-slate-300">
                            {p.action === 'rollback' ? 'Rolled back' : 'Published'}: {p.summary}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-1.5 flex gap-[2px] text-[11px] text-slate-400">
            {daily.map((d, i) => (
              <span key={d.day} className="flex-1 overflow-visible whitespace-nowrap text-center">
                {i % labelEvery === 0 ? dayLabel(d.day, { month: 'short', day: 'numeric' }) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>

      {publishes.length > 0 && (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block h-3 border-l border-dashed border-slate-500" aria-hidden="true" />
          A new version went live that day
        </p>
      )}

      <table className="sr-only">
        <caption>{m.title}, per day</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">{m.label}</th>
            <th scope="col">Based on</th>
            <th scope="col">Published</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d, i) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{values[i] === null ? '—' : m.format(values[i]!)}</td>
              <td>{m.basis(d)}</td>
              <td>{publishedOn.get(d.day)?.map((p) => p.summary).join('; ') ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
