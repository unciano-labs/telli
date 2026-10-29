'use client';

import { useState } from 'react';

type Day = { day: string; calls: number; seconds: number };
type Metric = 'calls' | 'minutes';

const CHART_HEIGHT = 160;
const TICK_COUNT = 4;

function value(d: Day, metric: Metric) {
  return metric === 'calls' ? d.calls : Math.round((d.seconds / 60) * 10) / 10;
}

/** Rounds the axis max up to 1/2/5 × 10^n so ticks land on clean numbers. */
function niceMax(max: number) {
  if (max <= 0) return TICK_COUNT;
  const rough = max / TICK_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough)!;
  return Math.max(step, 1) * TICK_COUNT;
}

function compact(n: number) {
  return n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
}

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions) {
  // Noon UTC keeps the calendar day stable in any viewer timezone
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
}

/** Daily calls or minutes. One measure at a time: they have different scales. */
export default function UsageChart({ daily }: { daily: Day[] }) {
  const [metric, setMetric] = useState<Metric>('calls');
  const [hover, setHover] = useState<number | null>(null);

  const values = daily.map((d) => value(d, metric));
  const max = niceMax(Math.max(...values, 0));
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => (max / TICK_COUNT) * i);
  // Label ~6 dates across the axis
  const labelEvery = Math.max(1, Math.ceil(daily.length / 6));
  const unit = metric === 'calls' ? 'calls' : 'min';

  return (
    <figure>
      <div className="flex items-center justify-between gap-3">
        <figcaption className="text-sm font-medium text-slate-700">
          {metric === 'calls' ? 'Calls per day' : 'Talk minutes per day'}
        </figcaption>
        <div role="radiogroup" aria-label="Measure" className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
          {(['calls', 'minutes'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={metric === m}
              onClick={() => setMetric(m)}
              className={`rounded-md px-2.5 py-1 capitalize transition ${metric === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex gap-2" aria-hidden="true">
        {/* Y axis */}
        <div className="relative w-8 shrink-0 text-right text-[11px] text-slate-400" style={{ height: CHART_HEIGHT }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ bottom: `${(t / max) * 100}%` }}>
              {compact(t)}
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
                return (
                  <div
                    key={d.day}
                    className="relative flex h-full flex-1 items-end justify-center"
                    onMouseEnter={() => setHover(i)}
                  >
                    {active && <div className="absolute inset-y-0 w-full rounded-sm bg-slate-100/70" />}
                    <div
                      className={`relative w-full max-w-6 rounded-t transition-colors ${active ? 'bg-indigo-700' : 'bg-indigo-500'}`}
                      style={{ height: v > 0 ? `max(${(v / max) * 100}%, 2px)` : 0 }}
                    />
                    {active && (
                      <div
                        className={`pointer-events-none absolute bottom-full z-10 mb-2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg ${i < daily.length / 2 ? 'left-0' : 'right-0'}`}
                      >
                        <p className="font-medium">{dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                        <p className="text-slate-300">
                          {d.calls} {d.calls === 1 ? 'call' : 'calls'} · {Math.round((d.seconds / 60) * 10) / 10} min
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* X axis */}
          <div className="mt-1.5 flex gap-[2px] text-[11px] text-slate-400">
            {daily.map((d, i) => (
              <span key={d.day} className="flex-1 overflow-visible whitespace-nowrap text-center">
                {i % labelEvery === 0 ? dayLabel(d.day, { month: 'short', day: 'numeric' }) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>{metric === 'calls' ? 'Calls per day' : 'Talk minutes per day'}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Calls</th>
            <th scope="col">Minutes</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.calls}</td>
              <td>{Math.round((d.seconds / 60) * 10) / 10}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sr-only">Values in {unit}.</p>
    </figure>
  );
}
