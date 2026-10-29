import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { workspaceRoute } from '@/lib/route-auth';
import { changeMemberRole, listMembers, removeMember, TeamError } from '@/lib/team';
import { WORKSPACE_ROLES, type WorkspaceRole } from '@/lib/workspace-roles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ slug: string }> };

function errorResponse(error: unknown, label: string) {
  if (error instanceof TeamError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`[w/members ${label}]`, error);
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ members: await listMembers(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'GET');
  }
}

/** Body: { userId, role }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const userId = typeof body?.userId === 'string' ? body.userId : '';
  const role = body?.role as WorkspaceRole;
  if (!UUID.test(userId) || !WORKSPACE_ROLES.includes(role)) {
    return NextResponse.json({ error: 'userId and a valid role are required' }, { status: 400 });
  }

  try {
    await changeMemberRole(auth.workspace, { userId: auth.user.id, role: auth.role }, userId, role);
    return NextResponse.json({ members: await listMembers(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'PATCH');
  }
}

/** Query: ?userId=… Removes a member; any member may remove themselves (leave). */
export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;

  const userId = new URL(req.url).searchParams.get('userId') ?? '';
  if (!UUID.test(userId)) return NextResponse.json({ error: 'A valid userId is required' }, { status: 400 });

  try {
    await removeMember(auth.workspace, { userId: auth.user.id, role: auth.role }, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'DELETE');
  }
}
