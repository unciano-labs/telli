import { Suspense } from 'react';
import { connection } from 'next/server';
import AnalyticsView from '@/components/admin/AnalyticsView';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { getAnalytics, parseRange } from '@/lib/analytics';
import { listCallLogs } from '@/lib/call-logs';
import { listWidgets } from '@/lib/widgets';
import { errorMessage } from '@/lib/retell';

async function Analytics({ params, searchParams }: PageProps<'/w/[slug]/analytics'>) {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { workspace } = await requireWorkspacePage(slug, 'member', '/analytics');
  const days = parseRange(query.range);

  let loaded;
  try {
    const widgets = await listWidgets(workspace.id);
    const widgetId = widgets.some((w) => w.id === query.widget) ? (query.widget as string) : null;
    const [data, calls] = await Promise.all([
      getAnalytics({ workspaceId: workspace.id, days, widgetId: widgetId ?? undefined }),
      listCallLogs({ workspaceId: workspace.id, limit: 15 }),
    ]);
    loaded = { widgets, widgetId, data, calls };
  } catch (error) {
    return <LoadError title="Couldn’t load analytics" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  return (
    <AnalyticsView
      data={loaded.data}
      widgets={loaded.widgets.map((w) => ({ id: w.id, name: w.name }))}
      widgetId={loaded.widgetId}
      initialCalls={loaded.calls}
    />
  );
}

export default function AnalyticsPage(props: PageProps<'/w/[slug]/analytics'>) {
  return (
    <>
      <PageHeading title="Analytics" description="Calls, talk time and cost across your widgets and phone." />
      <Suspense fallback={<Loading label="Loading analytics…" />}>
        <Analytics {...props} />
      </Suspense>
    </>
  );
}
