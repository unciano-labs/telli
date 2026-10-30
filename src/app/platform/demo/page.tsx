import { Suspense } from 'react';
import { connection } from 'next/server';
import DemoAdmin from '@/components/admin/DemoAdmin';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireAdminPage } from '@/lib/auth';
import { ensureDemoAgent, getDemoBudgetUsage, listDemoLeads, liveScenarioOptions } from '@/lib/demo';
import { errorMessage } from '@/lib/retell';

async function Demo() {
  await connection();
  await requireAdminPage('/platform/demo');

  let loaded;
  try {
    // Creates the dedicated demo agent in Retell on first visit
    const settings = await ensureDemoAgent();
    const [budget, leads, liveOptions] = await Promise.all([getDemoBudgetUsage(settings), listDemoLeads(), liveScenarioOptions()]);
    loaded = { settings, budget, leads, liveOptions };
  } catch (error) {
    return <LoadError title="Couldn’t load the demo" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  const { settings, budget, leads, liveOptions } = loaded;
  return (
    <DemoAdmin
      initialSettings={{
        enabled: settings.enabled,
        seconds_per_user: settings.seconds_per_user,
        daily_budget_minutes: settings.daily_budget_minutes,
        contact_url: settings.contact_url,
        scenario_workspaces: settings.scenario_workspaces ?? {},
      }}
      budget={budget}
      leads={leads}
      demoAgentId={settings.retell_agent_id}
      liveOptions={liveOptions}
    />
  );
}

export default function DemoAdminPage() {
  return (
    <>
      <PageHeading
        title="Public demo"
        description="Signed-up visitors get free talk time with sample businesses. Control the time and budget, and see who tried it."
      />
      <Suspense fallback={<Loading label="Loading demo…" />}>
        <Demo />
      </Suspense>
    </>
  );
}
