import { Suspense } from 'react';
import { connection } from 'next/server';
import Dialer from '@/components/Dialer';
import Playground from '@/components/studio/Playground';
import TestCases from '@/components/studio/TestCases';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { prepareDraft } from '@/lib/agent-draft';
import { latestTestRun, listTestCases } from '@/lib/agent-tests';
import { errorMessage } from '@/lib/retell';

async function Test({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'member', '/test');

  let data;
  try {
    const config = await prepareDraft(workspace);
    const [cases, run] = await Promise.all([listTestCases(workspace), latestTestRun(workspace)]);
    data = { config, cases, run };
  } catch (error) {
    return <LoadError title="Couldn’t load testing" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  const { config, cases, run } = data;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-8">
        <Playground greeting={config.begin_message} hasLive={config.live_version !== null} />
        <TestCases initialCases={cases} initialRun={run} draftChangedAt={config.draft_changed_at} />
      </div>
      <section aria-labelledby="voice-test-heading">
        <h2 id="voice-test-heading" className="mb-3 text-sm font-semibold text-slate-900">
          Call the draft
        </h2>
        <Dialer agentName={config.agent_name} endpoint={`/api/w/${workspace.slug}/test-call`} tagline="Test calls use your draft" />
        <p className="mt-3 max-w-sm text-xs text-slate-500">
          Test calls count toward your minutes but stay out of analytics.
        </p>
      </section>
    </div>
  );
}

export default function TestPage({ params }: PageProps<'/w/[slug]/test'>) {
  return (
    <>
      <PageHeading title="Test" description="Try your draft before callers hear it: chat, call, or run your test cases." />
      <Suspense fallback={<Loading label="Loading…" />}>
        <Test params={params} />
      </Suspense>
    </>
  );
}
