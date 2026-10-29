import { Suspense } from 'react';
import { connection } from 'next/server';
import WidgetManager from '@/components/admin/WidgetManager';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { listWidgets } from '@/lib/widgets';
import { errorMessage } from '@/lib/retell';

async function Widgets({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'admin', '/widgets');

  let widgets;
  try {
    widgets = await listWidgets(workspace.id);
  } catch (error) {
    return <LoadError title="Couldn’t load widgets" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }
  return <WidgetManager initialWidgets={widgets} />;
}

export default function WidgetsPage({ params }: PageProps<'/w/[slug]/widgets'>) {
  return (
    <>
      <PageHeading
        title="Website widgets"
        description="Add the voice agent to any website with one line of code. Each widget has its own look and allowed sites."
      />
      <Suspense fallback={<Loading label="Loading widgets…" />}>
        <Widgets params={params} />
      </Suspense>
    </>
  );
}
