import { Suspense } from 'react';
import AuthCard from '@/components/auth/AuthCard';
import { LoginForm } from '@/components/auth/AuthForms';

const NOTICES: Record<string, string> = {
  forbidden: 'Your account doesn’t have admin access to Voice Agent.',
  confirmed: 'Your email is confirmed. Log in to continue.',
  // Supabase adds error_code when a confirmation link can't be used
  otp_expired: 'That confirmation link has expired or was already used. Try logging in, or sign up again to get a new link.',
};

async function LoginFormWithParams({ searchParams }: { searchParams: PageProps<'/login'>['searchParams'] }) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const key = [params.notice, params.error_code, params.error].find((v) => typeof v === 'string' && v in NOTICES) as string | undefined;
  return <LoginForm next={next} notice={key && NOTICES[key]} />;
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
