import { Suspense } from 'react';
import { connection } from 'next/server';
import SiteHeader from '@/components/SiteHeader';
import OnboardingForm from '@/components/workspace/OnboardingForm';
import { Loading, PageHeading } from '@/components/admin/PageStates';
import { requireMemberPage } from '@/lib/auth';

async function Gate() {
  await connection();
  await requireMemberPage('/onboarding');
  return <OnboardingForm />;
}

export default function OnboardingPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-16 pt-4 sm:px-6">
        <PageHeading
          title="Set up your voice agent"
          description="Two quick choices. Next you’ll add your business info, make a test call and get the code for your website."
        />
        <Suspense fallback={<Loading label="Loading…" />}>
          <Gate />
        </Suspense>
      </main>
    </div>
  );
}
