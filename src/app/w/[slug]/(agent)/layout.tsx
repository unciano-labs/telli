import { Suspense } from 'react';
import { connection } from 'next/server';
import PublishBar, { type PublishBarProps } from '@/components/studio/PublishBar';
import StudioNav from '@/components/studio/StudioNav';
import { requireWorkspacePage } from '@/lib/auth';
import { getDraftStatus, prepareDraft } from '@/lib/agent-draft';
import { latestTestRun, listTestCases } from '@/lib/agent-tests';
import { errorMessage } from '@/lib/retell';

async function StudioStatus({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'member');

  let props: PublishBarProps;
  try {
    const config = await prepareDraft(workspace);
    const [status, cases, run] = await Promise.all([
      getDraftStatus(workspace, config),
      listTestCases(workspace),
      latestTestRun(workspace).catch(() => null),
    ]);
    const stale = run !== null && run.draft_changed_at !== config.draft_changed_at;
    props = {
      publishedAt: status.publishedAt,
      pendingEdits: status.pendingEdits,
      tests: {
        cases: cases.length,
        failed: run ? run.fail_count + run.error_count : 0,
        status: !run
          ? 'none'
          : run.status === 'running'
            ? 'running'
            : stale
              ? 'stale'
              : run.fail_count + run.error_count > 0
                ? 'failed'
                : 'passed',
      },
    };
  } catch (error) {
    // The page below shows the full error; the bar just stays quiet
    console.error('[studio] status failed', errorMessage(error));
    return null;
  }
  return <PublishBar {...props} />;
}

export default function StudioLayout({ children, params }: LayoutProps<'/w/[slug]'>) {
  return (
    <div className="space-y-6">
      <StudioNav />
      <Suspense fallback={null}>
        <StudioStatus params={params} />
      </Suspense>
      <div className="pt-2">{children}</div>
    </div>
  );
}
