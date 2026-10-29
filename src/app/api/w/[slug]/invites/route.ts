import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { rateLimit } from '@/lib/rate-limit';
import { workspaceRoute } from '@/lib/route-auth';
import { createInvite, listInvites, revokeInvite, TeamError } from '@/lib/team';
import type { WorkspaceRole } from '@/lib/workspace-roles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INVITES = 20;
const WINDOW_MS = 60 * 60 * 1000;

type Params = { params: Promise<{ slug: string }> };

function errorResponse(error: unknown, label: string) {
  if (error instanceof TeamError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`[w/invites ${label}]`, error);
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ invites: await listInvites(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'GET');
  }
}

/** Body: { email, role }. Returns the invite and its one-time link path. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  if (!rateLimit(`invite:${auth.workspace.id}`, MAX_INVITES, WINDOW_MS).allowed) {
    return NextResponse.json({ error: 'Too many invites. Try again later.' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email : '';
  const role = body?.role as WorkspaceRole;

  try {
    const { invite, token } = await createInvite(
      auth.workspace,
      { userId: auth.user.id, role: auth.role },
      { email, role }
    );
    return NextResponse.json({ invite, path: `/invite/${token}` }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'POST');
  }
}

/** Query: ?id=… Revokes an open invite. */
export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'A valid invite id is required' }, { status: 400 });

  try {
    await revokeInvite(auth.workspace, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'DELETE');
  }
}
