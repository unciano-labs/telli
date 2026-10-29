import { Suspense } from 'react';
import AuthCard from '@/components/auth/AuthCard';
import { LoginForm } from '@/components/auth/AuthForms';

const NOTICES: Record<string, string> = {
  forbidden: 'Your account doesn’t have admin access to Voice Agent.',
};

async function LoginFormWithParams({ searchParams }: { searchParams: PageProps<'/login'>['searchParams'] }) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const error = typeof params.error === 'string' ? NOTICES[params.error] : undefined;
  return <LoginForm next={next} notice={error} />;
}

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <AuthCard title="Log in to Voice Agent" subtitle="Admins manage the agent and knowledge base here.">
      <Suspense fallback={<LoginForm />}>
        <LoginFormWithParams searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}
