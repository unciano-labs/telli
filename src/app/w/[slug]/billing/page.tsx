import { Suspense } from 'react';
import { connection } from 'next/server';
import BillingView from '@/components/workspace/BillingView';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { findWorkspaceById } from '@/lib/workspaces';
import { getBilling, lineItemsFor, listPayments, listPlans, NUMBER_FEE_CENTS, reconcilePayments } from '@/lib/billing';
import { paymongoTestMode } from '@/lib/paymongo';
import { usdToPhp, visitorCountry } from '@/lib/fx';
import { headers } from 'next/headers';
import { errorMessage } from '@/lib/retell';

async function Billing({ params, searchParams }: PageProps<'/w/[slug]/billing'>) {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { workspace: loaded } = await requireWorkspacePage(slug, 'owner', '/billing');

  let data;
  try {
    // Apply payments PayMongo has confirmed (the webhook may not have arrived, or can't locally)
    await reconcilePayments(loaded);
    const workspace = (await findWorkspaceById(loaded.id)) ?? loaded;
    const [billing, plans, payments, rate] = await Promise.all([getBilling(workspace), listPlans(), listPayments(workspace), usdToPhp()]);
    const anyPlan = plans[0];
    const paidNumbers = anyPlan ? (await lineItemsFor(workspace, anyPlan)).length - 1 : 0;
    data = { billing, plans, payments, paidNumbers, rate };
  } catch (error) {
    return <LoadError title="Couldn’t load billing" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  const fromPhilippines = visitorCountry(await headers()) === 'PH';
  const returned = typeof query.payment === 'string' ? (data.payments.find((p) => p.id === query.payment) ?? null) : null;
  return (
    <BillingView
      billing={data.billing}
      plans={data.plans}
      payments={data.payments}
      numberFeeCents={NUMBER_FEE_CENTS}
      paidNumbers={data.paidNumbers}
      testMode={paymongoTestMode()}
      phpRate={data.rate}
      showPhp={fromPhilippines}
      returnedPayment={returned}
    />
  );
}

export default function BillingPage(props: PageProps<'/w/[slug]/billing'>) {
  return (
    <>
      <PageHeading title="Billing" description="Your plan, this month’s minutes and your payments." />
      <Suspense fallback={<Loading label="Loading billing…" />}>
        <Billing {...props} />
      </Suspense>
    </>
  );
}
