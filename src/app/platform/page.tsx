import { Suspense } from 'react';
import { connection } from 'next/server';
import PlatformWorkspaces from '@/components/platform/PlatformWorkspaces';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireAdminPage } from '@/lib/auth';
import { listPlatformWorkspaces } from '@/lib/workspaces';
import { listPlans } from '@/lib/billing';
import { errorMessage } from '@/lib/retell';

const DAYS = 30;

async function Workspaces() {
  await connection();
  await requireAdminPage('/platform');

  let data;
  try {
    const [rows, plans] = await Promise.all([listPlatformWorkspaces(DAYS), listPlans()]);
    data = { rows, plans: plans.map((p) => ({ code: p.code, name: p.name })) };
  } catch (error) {
    return <LoadError title="Couldn’t load workspaces" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }
  return <PlatformWorkspaces initial={data.rows} days={DAYS} plans={data.plans} />;
}

export default function PlatformPage() {
  return (
    <>
      <PageHeading
        title="Workspaces"
        description="Every business on the platform. Grant months, suspend accounts and watch usage and cost."
      />
      <Suspense fallback={<Loading label="Loading workspaces…" />}>
        <Workspaces />
      </Suspense>
    </>
  );
}
