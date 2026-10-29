import { Suspense } from 'react';
import { connection } from 'next/server';
import PhoneNumbers from '@/components/workspace/PhoneNumbers';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { isWebsiteAdmin, requireWorkspacePage } from '@/lib/auth';
import { findAgentConfig } from '@/lib/agent-config';
import {
  CALLABLE_COUNTRIES,
  listNumbers,
  RETELL_COUNTRIES,
  RETELL_NUMBER_PRICE_CENTS,
  RETELL_SIP_URI,
  TWILIO_COUNTRIES,
} from '@/lib/phone-numbers';
import { twilioConfigured } from '@/lib/twilio';
import { getBilling } from '@/lib/billing';
import { errorMessage } from '@/lib/retell';

async function Numbers({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace, user } = await requireWorkspacePage(slug, 'admin', '/numbers');

  let data;
  try {
    const [numbers, config, canBuy, billing] = await Promise.all([
      listNumbers(workspace.id),
      findAgentConfig(workspace.id),
      isWebsiteAdmin(user.id),
      getBilling(workspace),
    ]);
    data = { numbers, callerId: config?.retell_phone_number ?? null, canBuy, max: billing.limits.max_numbers };
  } catch (error) {
    return <LoadError title="Couldn’t load phone numbers" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  return (
    <PhoneNumbers
      initialNumbers={data.numbers}
      callerId={data.callerId}
      canBuy={data.canBuy}
      twilioEnabled={twilioConfigured()}
      max={data.max}
      retellPriceCents={RETELL_NUMBER_PRICE_CENTS}
      retellCountries={RETELL_COUNTRIES}
      twilioCountries={TWILIO_COUNTRIES}
      callableCountries={CALLABLE_COUNTRIES}
      sipUri={RETELL_SIP_URI}
    />
  );
}

export default function NumbersPage({ params }: PageProps<'/w/[slug]/numbers'>) {
  return (
    <>
      <PageHeading
        title="Phone numbers"
        description="Give your agent a phone number. Callers reach your published agent, and it can call people from the same number."
      />
      <Suspense fallback={<Loading label="Loading phone numbers…" />}>
        <Numbers params={params} />
      </Suspense>
    </>
  );
}
