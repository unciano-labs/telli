import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { addWebPage, getKbSummary, KbError, refreshWebPage, removeWebPage } from '@/lib/knowledge-base';

type Params = { params: Promise<{ slug: string }> };

function sourceIdFrom(req: Request) {
  const id = new URL(req.url).searchParams.get('sourceId') ?? '';
  return /^[\w-]{1,100}$/.test(id) ? id : null;
}

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ summary: await getKbSummary(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/pages GET', [KbError]);
  }
}

/** Body: { url }. Imports a web page into the knowledge base. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  try {
    await addWebPage(auth.workspace, auth.user.id, typeof body?.url === 'string' ? body.url : '');
    return NextResponse.json({ summary: await getKbSummary(auth.workspace) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/pages POST', [KbError]);
  }
}

/** Query: ?sourceId=… Re-imports the page now. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const sourceId = sourceIdFrom(req);
  if (!sourceId) return NextResponse.json({ error: 'A valid sourceId is required' }, { status: 400 });
  try {
    await refreshWebPage(auth.workspace, auth.user.id, sourceId);
    return NextResponse.json({ summary: await getKbSummary(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/pages PATCH', [KbError]);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const sourceId = sourceIdFrom(req);
  if (!sourceId) return NextResponse.json({ error: 'A valid sourceId is required' }, { status: 400 });
  try {
    await removeWebPage(auth.workspace, auth.user.id, sourceId);
    return NextResponse.json({ summary: await getKbSummary(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/pages DELETE', [KbError]);
  }
}
