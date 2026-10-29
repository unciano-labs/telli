import { Suspense } from 'react';
import { connection } from 'next/server';
import ModulesManager from '@/components/studio/ModulesManager';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { listRentals, listServices } from '@/lib/bookings';
import { getModuleStates } from '@/lib/modules-agent';
import { publicAppUrl } from '@/lib/public-url';
import { errorMessage } from '@/lib/retell';

async function Modules({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'admin', '/modules');

  let data;
  try {
    const [modules, services, rentals] = await Promise.all([
      getModuleStates(workspace.id),
      listServices(workspace.id),
      listRentals(workspace.id),
    ]);
    data = { modules, services, rentals };
  } catch (error) {
    return <LoadError title="Couldn’t load bookings" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }
  return (
    <ModulesManager initialModules={data.modules} services={data.services} rentals={data.rentals} connected={Boolean(publicAppUrl())} />
  );
}

export default function ModulesPage({ params }: PageProps<'/w/[slug]/modules'>) {
  return (
    <>
      <PageHeading
        title="Modules"
        description="Let your agent check what’s free and book it during the call: appointments, tables, viewings or stays."
      />
      <Suspense fallback={<Loading label="Loading modules…" />}>
        <Modules params={params} />
      </Suspense>
    </>
  );
}
