import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { addRule, deleteRule, DraftError, listRules } from '@/lib/agent-draft';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body: { rule }. Adds a rule to the draft prompt. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  try {
    await addRule(auth.workspace, auth.user.id, typeof body?.rule === 'string' ? body.rule : '');
    return NextResponse.json({ rules: await listRules(auth.workspace.id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/rules POST', [DraftError]);
  }
}

/** Query: ?id=… */
export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'A valid rule id is required' }, { status: 400 });
  try {
    await deleteRule(auth.workspace, auth.user.id, id);
    return NextResponse.json({ rules: await listRules(auth.workspace.id) });
  } catch (error) {
    return errorResponse(error, 'w/rules DELETE', [DraftError]);
  }
}
