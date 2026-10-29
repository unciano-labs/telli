import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import ImproveTabs from '@/components/studio/ImproveTabs';
import QualityChart from '@/components/studio/QualityChart';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { parseRange, RANGES } from '@/lib/analytics';
import { CALLER_INTENTS } from '@/lib/call-analysis';
import { getQuality, listCorrections, listQuestionGroups, listReviewCalls, type Quality } from '@/lib/improve';
import { errorMessage } from '@/lib/retell';

function rate(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '—';
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-400">{note}</p>
    </div>
  );
}

function QualitySection({ quality, slug }: { quality: Quality; slug: string }) {
  const { totals, lastPublish } = quality;
  const rated = totals.up + totals.down;
  const avg = totals.calls ? totals.seconds / totals.calls : 0;
  const maxIntent = Math.max(...quality.intents.map((i) => i.calls), 1);
  const compare =
    lastPublish && lastPublish.before.analyzed > 0 && lastPublish.after.analyzed > 0 ? lastPublish : null;

  return (
    <section className="space-y-4" aria-labelledby="quality-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="quality-heading" className="mr-auto text-base font-semibold text-slate-900">
          Call quality
        </h2>
        <div className="flex rounded-lg bg-white p-0.5 text-sm font-medium shadow-sm ring-1 ring-slate-200">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/w/${slug}/improve?range=${r}`}
              scroll={false}
              aria-current={quality.days === r ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 transition ${quality.days === r ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:text-slate-900'}`}
            >
              {r} days
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Resolved" value={rate(totals.resolved, totals.analyzed)} note={`of ${totals.analyzed} analyzed calls`} />
        <Stat
          label="Had an unanswered question"
          value={rate(totals.withUnanswered, totals.analyzed)}
          note={`of ${totals.analyzed} analyzed calls`}
        />
        <Stat
          label="Caller 👍"
          value={rate(totals.up, rated)}
          note={rated ? `${totals.up} 👍 · ${totals.down} 👎 from widget callers` : 'No widget ratings yet'}
        />
        <Stat
          label="Average call"
          value={avg ? `${Math.floor(avg / 60)}:${String(Math.round(avg % 60)).padStart(2, '0')}` : '—'}
          note={`${totals.calls} connected calls`}
        />
      </div>

      {compare && (
        <p className="text-sm text-slate-600">
          Since the last publish on{' '}
          {new Date(compare.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}:{' '}
          <span className="font-medium text-slate-900">{rate(compare.after.resolved, compare.after.analyzed)} resolved</span> (
          {compare.after.analyzed} calls), compared with {rate(compare.before.resolved, compare.before.analyzed)} before (
          {compare.before.analyzed} calls).
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-2">
          <QualityChart daily={quality.daily} publishes={quality.publishes} />
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h3 className="text-sm font-medium text-slate-700">Why people call</h3>
          {quality.intents.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No analyzed calls in this period.</p>
          ) : (
            <ul className="mt-2">
              {quality.intents.map((i) => (
                <li key={i.intent} className="py-2">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-slate-700">{CALLER_INTENTS[i.intent]}</span>
                    <span className="shrink-0 font-medium text-slate-900">{i.calls}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-indigo-50">
                    <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${(i.calls / maxIntent) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Days in {quality.timezone}. Retell analyzes each call about a minute after it ends. Test and demo calls are left out.
      </p>
    </section>
  );
}

async function Improve({ params, searchParams }: PageProps<'/w/[slug]/improve'>) {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { workspace } = await requireWorkspacePage(slug, 'member', '/improve');

  let data;
  try {
    // Review calls first: it refreshes recent calls from Retell, which fills the inbox
    const calls = await listReviewCalls(workspace, 'needs_review');
    const [quality, groups, corrections] = await Promise.all([
      getQuality(workspace, parseRange(query.range)),
      listQuestionGroups(workspace),
      listCorrections(workspace),
    ]);
    data = { calls, quality, groups, corrections };
  } catch (error) {
    return <LoadError title="Couldn’t load call reviews" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  return (
    <div className="space-y-10">
      <QualitySection quality={data.quality} slug={slug} />
      <ImproveTabs groups={data.groups} calls={data.calls} corrections={data.corrections} />
    </div>
  );
}

export default function ImprovePage(props: PageProps<'/w/[slug]/improve'>) {
  return (
    <>
      <PageHeading
        title="Improve"
        description="Learn from real calls: answer what callers asked, fix wrong answers, and see whether each version helped."
      />
      <Suspense fallback={<Loading label="Loading call reviews…" />}>
        <Improve {...props} />
      </Suspense>
    </>
  );
}
