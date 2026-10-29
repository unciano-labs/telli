import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import AuthCard from '@/components/auth/AuthCard';
import AcceptInvite from '@/components/workspace/AcceptInvite';
import { Loading } from '@/components/admin/PageStates';
import { createClient } from '@/lib/supabase/server';
import { hasWebsiteAccess } from '@/lib/auth';
import { previewInvite } from '@/lib/team';
import { ROLE_LABELS } from '@/lib/workspace-roles';

export const metadata: Metadata = { robots: { index: false, follow: false } };

const linkCls = 'inline-flex w-full items-center justify-center rounded-full px-5 py-2.5 font-semibold';

async function Invite({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const invite = await previewInvite(token).catch(() => null);
  if (!invite) {
    return <p className="text-center text-sm text-slate-600">This invite link is invalid or was already used. Ask for a new one.</p>;
  }
  if (invite.expired) {
    return <p className="text-center text-sm text-slate-600">This invite has expired. Ask for a new one.</p>;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const next = encodeURIComponent(`/invite/${token}`);
  const summary = (
    <p className="text-center text-sm text-slate-600">
      You’re invited to <span className="font-semibold text-slate-900">{invite.workspaceName}</span> as{' '}
      {ROLE_LABELS[invite.role].toLowerCase()}. The invite is for{' '}
      <span className="font-medium text-slate-900">{invite.email}</span>.
    </p>
  );

  if (!user || !(await hasWebsiteAccess(user.id))) {
    return (
      <>
        {summary}
        <div className="mt-6 space-y-3">
          <Link href={`/signup?email=${encodeURIComponent(invite.email)}&next=${next}`} className={`${linkCls} bg-indigo-600 text-white hover:bg-indigo-500`}>
            Create an account
          </Link>
          <Link href={`/login?next=${next}`} className={`${linkCls} text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50`}>
            I already have an account
          </Link>
        </div>
      </>
    );
  }

  if (user.email?.toLowerCase() !== invite.email) {
    return (
      <>
        {summary}
        <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          You’re logged in as {user.email}. Log out, then log in or sign up as {invite.email} to join.
        </p>
      </>
    );
  }

  return (
    <>
      {summary}
      <AcceptInvite token={token} />
    </>
  );
}

export default function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  return (
    <AuthCard title="Join a workspace" subtitle="Voice Agent">
      <Suspense fallback={<Loading label="Checking your invite…" />}>
        <Invite params={params} />
      </Suspense>
    </AuthCard>
  );
}
