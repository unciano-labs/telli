import { Suspense } from 'react';
import { connection } from 'next/server';
import TeamManager from '@/components/workspace/TeamManager';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { listInvites, listMembers } from '@/lib/team';
import { hasRole } from '@/lib/workspace-roles';
import { errorMessage } from '@/lib/retell';

async function Team({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace, role, user } = await requireWorkspacePage(slug, 'member', '/team');

  let loaded;
  try {
    const [members, invites] = await Promise.all([
      listMembers(workspace),
      hasRole(role, 'admin') ? listInvites(workspace) : Promise.resolve([]),
    ]);
    loaded = { members, invites };
  } catch (error) {
    return <LoadError title="Couldn’t load the team" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }
  return <TeamManager initialMembers={loaded.members} initialInvites={loaded.invites} currentUserId={user.id} />;
}

export default function TeamPage({ params }: PageProps<'/w/[slug]/team'>) {
  return (
    <>
      <PageHeading title="Team" description="Invite the people who manage this agent and choose what they can change." />
      <Suspense fallback={<Loading label="Loading team…" />}>
        <Team params={params} />
      </Suspense>
    </>
  );
}
