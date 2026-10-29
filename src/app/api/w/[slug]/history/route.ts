import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { DraftError, listChanges, rollbackTo } from '@/lib/agent-draft';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ changes: await listChanges(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/history GET', [DraftError]);
  }
}

/** Body: { changeId }. Makes that published version live again. Owners and admins only. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  const changeId = typeof body?.changeId === 'string' ? body.changeId : '';
  if (!UUID.test(changeId)) return NextResponse.json({ error: 'A valid changeId is required' }, { status: 400 });
  try {
    await rollbackTo(auth.workspace, auth.user.id, changeId);
    return NextResponse.json({ changes: await listChanges(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/history POST', [DraftError]);
  }
}
