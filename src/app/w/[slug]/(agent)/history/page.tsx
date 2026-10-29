import { Suspense } from 'react';
import { connection } from 'next/server';
import HistoryList from '@/components/studio/HistoryList';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { listChanges, prepareDraft } from '@/lib/agent-draft';
import { errorMessage } from '@/lib/retell';

async function History({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'member', '/history');

  let data;
  try {
    const [config, changes] = await Promise.all([prepareDraft(workspace), listChanges(workspace)]);
    data = { config, changes };
  } catch (error) {
    return <LoadError title="Couldn’t load history" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }
  return <HistoryList initialChanges={data.changes} liveVersion={data.config.live_version} />;
}

export default function HistoryPage({ params }: PageProps<'/w/[slug]/history'>) {
  return (
    <>
      <PageHeading
        title="History"
        description="Every change, who made it, and when. Roll back to any version you published before."
      />
      <Suspense fallback={<Loading label="Loading history…" />}>
        <History params={params} />
      </Suspense>
    </>
  );
}
