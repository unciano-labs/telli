import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireAdminPage } from '@/lib/auth';
import { getRevenueReport } from '@/lib/billing';
import { formatUsd } from '@/lib/money';
import { errorMessage } from '@/lib/retell';

const DAYS = 30;
const money = (cents: number) => formatUsd(Math.round(cents));

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-400">{note}</p>
    </div>
  );
}

async function Revenue() {
  await connection();
  await requireAdminPage('/platform/revenue');

  let report;
  try {
    report = await getRevenueReport(DAYS);
  } catch (error) {
    return <LoadError title="Couldn’t load revenue" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }
  const revenue = report.rows.reduce((sum, r) => sum + r.revenue_cents, 0);
  const cost = report.rows.reduce((sum, r) => sum + r.cost_cents, 0);
  const negative = report.rows.filter((r) => r.margin_cents < 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Monthly recurring revenue" value={money(report.mrr_cents)} note="paid months in progress" />
        <Stat label={`Revenue (${DAYS} days)`} value={money(revenue)} note="payments received" />
        <Stat label={`Cost (${DAYS} days)`} value={money(cost)} note="Retell calls + numbers" />
        <Stat label="Negative margin" value={String(negative.length)} note={negative.length === 1 ? 'workspace' : 'workspaces'} />
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Revenue against cost per workspace, last {DAYS} days</caption>
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3">Workspace</th>
              <th scope="col" className="px-4 py-3">Plan</th>
              <th scope="col" className="px-4 py-3 text-right">Revenue</th>
              <th scope="col" className="px-4 py-3 text-right">Cost</th>
              <th scope="col" className="px-4 py-3 text-right">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No customer workspaces yet.
                </td>
              </tr>
            )}
            {report.rows.map((r) => (
              <tr key={r.workspace_id}>
                <td className="px-4 py-3">
                  <Link href={`/w/${r.slug}`} className="font-medium text-indigo-600 hover:text-indigo-500">
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {r.plan}
                  <span className="ml-1.5 text-xs text-slate-400">{r.state}</span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{money(r.revenue_cents)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(r.cost_cents)}</td>
                <td className={`px-4 py-3 text-right font-medium tabular-nums ${r.margin_cents < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                  {money(r.margin_cents)}
                  {r.margin_cents < 0 && <span className="ml-1 text-xs font-normal">· loss</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Worst margin first. Trial workspaces show their cost with no revenue. Twilio call charges aren’t included yet; the platform
        workspace isn’t listed.
      </p>
    </div>
  );
}

export default function RevenuePage() {
  return (
    <>
      <PageHeading title="Revenue" description={`What each workspace paid against what its calls and numbers cost us, last ${DAYS} days.`} />
      <Suspense fallback={<Loading label="Loading revenue…" />}>
        <Revenue />
      </Suspense>
    </>
  );
}
