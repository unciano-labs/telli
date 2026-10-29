import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { ArrowRight, Plus } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import StatusBadge from '@/components/workspace/StatusBadge';
import { LoadError, Loading, PageHeading } from '@/components/admin/PageStates';
import { requireMemberPage } from '@/lib/auth';
import { listUserWorkspaces, MAX_OWNED_WORKSPACES } from '@/lib/workspaces';
import { ROLE_LABELS } from '@/lib/workspace-roles';
import { errorMessage } from '@/lib/retell';

async function Workspaces() {
  await connection();
  const user = await requireMemberPage('/dashboard');

  let workspaces;
  try {
    workspaces = await listUserWorkspaces(user.id);
  } catch (error) {
    return <LoadError title="Couldn’t load your workspaces" message={errorMessage(error)} />;
  }
  if (workspaces.length === 0) redirect('/onboarding');

  const owned = workspaces.filter((w) => w.role === 'owner' && !w.is_platform).length;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {workspaces.map((w) => (
        <Link
          key={w.id}
          href={w.role === 'member' ? `/w/${w.slug}/analytics` : `/w/${w.slug}`}
          className="group flex flex-col rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-slate-900">{w.name}</p>
            <StatusBadge status={w.status} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {ROLE_LABELS[w.role]}
            {w.is_platform && ' · runs this site’s own agent'}
          </p>
          <span className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-indigo-600 group-hover:text-indigo-500">
            Open <ArrowRight className="h-4 w-4" />
          </span>
        </Link>
      ))}
      {owned < MAX_OWNED_WORKSPACES && (
        <Link
          href="/onboarding"
          className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-5 text-sm font-medium text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600"
        >
          <Plus className="h-5 w-5" /> New workspace
        </Link>
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-4 sm:px-6">
        <PageHeading title="Your workspaces" description="Each workspace is one business with its own agent, documents, widgets and team." />
        <Suspense fallback={<Loading label="Loading workspaces…" />}>
          <Workspaces />
        </Suspense>
      </main>
    </div>
  );
}
