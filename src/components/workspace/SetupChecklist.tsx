import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';

export type SetupStep = { label: string; detail: string; done: boolean; href?: string };

/** Getting-started steps for a new workspace; hidden once everything is done. */
export default function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  return (
    <section aria-labelledby="setup-heading" className="mb-8 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="setup-heading" className="font-semibold text-slate-900">
          Get your agent live
        </h2>
        <span className="text-sm tabular-nums text-slate-500">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((step, i) => {
          const body = (
            <>
              {step.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-label="Done" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-slate-300" aria-label="Not done" />
              )}
              <span>
                <span className={`block text-sm font-medium ${step.done ? 'text-slate-500' : 'text-slate-900'}`}>
                  {i + 1}. {step.label}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{step.detail}</span>
              </span>
            </>
          );
          return (
            <li key={step.label}>
              {step.href && !step.done ? (
                <Link href={step.href} className="flex h-full gap-3 rounded-xl p-3 ring-1 ring-slate-200 transition hover:bg-slate-50">
                  {body}
                </Link>
              ) : (
                <div className="flex h-full gap-3 rounded-xl p-3 ring-1 ring-slate-100">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
