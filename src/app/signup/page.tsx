import { Suspense } from 'react';
import AuthCard from '@/components/auth/AuthCard';
import { SignupForm } from '@/components/auth/AuthForms';

const NOTICES: Record<string, string> = {
  not_registered:
    'This account isn’t registered for Voice Agent yet. Sign up below; if you already have an account on another site, use the same password.',
};

async function SignupFormWithParams({ searchParams }: { searchParams: PageProps<'/signup'>['searchParams'] }) {
  const params = await searchParams;
  const email = typeof params.email === 'string' ? params.email : undefined;
  const notice = typeof params.notice === 'string' ? NOTICES[params.notice] : undefined;
  const next = typeof params.next === 'string' ? params.next : undefined;
  return <SignupForm email={email} notice={notice} next={next} />;
}

export default function SignupPage({ searchParams }: PageProps<'/signup'>) {
  return (
    <AuthCard title="Create your Voice Agent account" subtitle="Sign up to access Voice Agent.">
      <Suspense fallback={<SignupForm />}>
        <SignupFormWithParams searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}
