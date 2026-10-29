import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { ChevronLeft, ShieldAlert } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import { Loading } from '@/components/admin/PageStates';
import StatusBadge from '@/components/workspace/StatusBadge';
import WorkspaceNav from '@/components/workspace/WorkspaceNav';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceContext';
import { requireWorkspacePage } from '@/lib/auth';
import type { Workspace } from '@/lib/workspaces';
import { getBilling } from '@/lib/billing';
import { enabledModules } from '@/lib/modules-agent';
import { hasRole, type WorkspaceRole } from '@/lib/workspace-roles';

function minutes(seconds: number) {
  return Math.max(Math.floor(seconds / 60), 0);
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Trial time, minutes running low, the paid month ending. Owners get a link to Billing. */
async function PlanNotice({ workspace, role }: { workspace: Workspace; role: WorkspaceRole }) {
  if (workspace.status === 'suspended') {
    return (
      <p className="mt-6 rounded-2xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-200">
        This workspace is suspended, so the agent isn’t taking calls. Contact us to turn it back on.
      </p>
    );
  }
  const billing = await getBilling(workspace).catch(() => null);
  if (!billing || billing.state === 'platform') return null;
  const action = hasRole(role, 'owner') ? (
    <Link href={`/w/${workspace.slug}/billing`} className="font-semibold underline underline-offset-2">
      {billing.state === 'trial' ? 'Choose a plan' : billing.state === 'expired' ? 'Renew' : 'Go to Billing'}
    </Link>
  ) : (
    'Ask the workspace owner to update the plan.'
  );

  let tone: 'amber' | 'red' = 'amber';
  let text: string | null = null;
  const used = billing.minutes?.usedSeconds ?? 0;
  const included = billing.minutes?.includedSeconds ?? 0;
  if (billing.state === 'trial') {
    const left = included - used;
    text = left > 0 ? `Free trial: ${minutes(left)} of ${minutes(included)} minutes left.` : 'Your free trial minutes are used up, so calls are paused.';
    if (left <= 0) tone = 'red';
  } else if (billing.state === 'expired') {
    text = `Your paid month ended${billing.paidThrough ? ` on ${day(billing.paidThrough)}` : ''}, so calls are paused.`;
    tone = 'red';
  } else if (included && used >= included) {
    text = `This month’s ${minutes(included)} minutes are used up, so calls are paused until ${day(billing.period!.end)}.`;
    tone = 'red';
  } else if (included && used >= included * 0.8) {
    text = `You’ve used ${Math.round((used / included) * 100)}% of this month’s minutes (${minutes(used)} of ${minutes(included)}).`;
  } else if (billing.renewalDue && billing.period) {
    text = `Your plan ends on ${day(billing.period.end)}. Pay for next month to keep taking calls.`;
  }
  if (!text) return null;
  const cls = tone === 'red' ? 'bg-red-50 text-red-800 ring-red-200' : 'bg-amber-50 text-amber-900 ring-amber-200';
  return (
    <p className={`mt-6 rounded-2xl p-4 text-sm ring-1 ${cls}`}>
      {text} {action}
    </p>
  );
}

async function WorkspaceShell({ params, children }: { params: Promise<{ slug: string }>; children: React.ReactNode }) {
  await connection();
  const { slug } = await params;
  const { workspace, role, viaPlatform } = await requireWorkspacePage(slug, 'member');
  const modules = (await enabledModules(workspace.id).catch(() => [])).map((m) => m.module);

  return (
    <WorkspaceProvider
      value={{
        slug: workspace.slug,
        name: workspace.name,
        role,
        status: workspace.status,
        isPlatform: workspace.is_platform,
        modules,
      }}
    >
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ChevronLeft className="h-4 w-4" /> Workspaces
        </Link>
        <span className="text-slate-300">/</span>
        <span className="font-semibold text-slate-900">{workspace.name}</span>
        <StatusBadge status={workspace.status} />
        {viaPlatform && (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20">
            <ShieldAlert className="h-3.5 w-3.5" /> Viewing as platform admin
          </span>
        )}
      </div>
      <WorkspaceNav />
      <PlanNotice workspace={workspace} role={role} />
      <div className="pt-8">{children}</div>
    </WorkspaceProvider>
  );
}

export default function WorkspaceLayout({ children, params }: LayoutProps<'/w/[slug]'>) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 sm:px-6">
        <Suspense fallback={<Loading label="Loading workspace…" />}>
          <WorkspaceShell params={params}>{children}</WorkspaceShell>
        </Suspense>
      </main>
    </div>
  );
}
