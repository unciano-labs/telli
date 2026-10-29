'use client';

import { useState } from 'react';
import { CircleHelp, ListChecks, PhoneCall } from 'lucide-react';
import QuestionInbox from '@/components/studio/QuestionInbox';
import ReviewCalls from '@/components/studio/ReviewCalls';
import CorrectionsList from '@/components/studio/CorrectionsList';
import type { Correction, QuestionGroup, ReviewCall } from '@/lib/improve';

type Tab = 'questions' | 'calls' | 'fixes';

/** The Improve tab's three work queues: unanswered questions, calls to review, and fixes. */
export default function ImproveTabs({
  groups,
  calls,
  corrections,
}: {
  groups: QuestionGroup[];
  calls: ReviewCall[];
  corrections: Correction[];
}) {
  const pending = corrections.filter((c) => c.status === 'pending').length;
  const [tab, setTab] = useState<Tab>(groups.length || !calls.length ? 'questions' : 'calls');
  const [counts, setCounts] = useState({ questions: groups.length, calls: calls.length, fixes: pending });

  const tabs = [
    { id: 'questions' as const, label: 'Unanswered questions', icon: CircleHelp, count: counts.questions },
    { id: 'calls' as const, label: 'Review calls', icon: PhoneCall, count: counts.calls },
    { id: 'fixes' as const, label: 'Fixes', icon: ListChecks, count: counts.fixes, countLabel: 'waiting for review' },
  ];

  return (
    <section className="space-y-4">
      <div role="tablist" aria-label="Improve" className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map(({ id, label, icon: Icon, count, countLabel }) => (
          <button
            key={id}
            role="tab"
            id={`improve-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`improve-panel-${id}`}
            onClick={() => setTab(id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${tab === id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {count > 0 && (
              <span
                className="rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-700"
                aria-label={`${count} ${countLabel ?? ''}`.trim()}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* Panels stay mounted so switching tabs keeps their state */}
      <div role="tabpanel" id="improve-panel-questions" aria-labelledby="improve-tab-questions" hidden={tab !== 'questions'}>
        <QuestionInbox initialGroups={groups} onCountChange={(n) => setCounts((c) => ({ ...c, questions: n }))} />
      </div>
      <div role="tabpanel" id="improve-panel-calls" aria-labelledby="improve-tab-calls" hidden={tab !== 'calls'}>
        <ReviewCalls initialCalls={calls} onCountChange={(n) => setCounts((c) => ({ ...c, calls: n }))} />
      </div>
      <div role="tabpanel" id="improve-panel-fixes" aria-labelledby="improve-tab-fixes" hidden={tab !== 'fixes'}>
        <CorrectionsList initialCorrections={corrections} onCountChange={(n) => setCounts((c) => ({ ...c, fixes: n }))} />
      </div>
    </section>
  );
}
