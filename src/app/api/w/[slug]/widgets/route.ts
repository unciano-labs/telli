import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { assertWithinLimit } from '@/lib/billing';
import { createWidget, listWidgets } from '@/lib/widgets';

type Params = { params: Promise<{ slug: string }> };


export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ widgets: await listWidgets(auth.workspace.id) });
  } catch (error) {
    console.error('[w/widgets GET]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

/** Body: { name }. Creates a widget with default theme and no allowed websites. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) {
    return NextResponse.json({ error: 'Name is required (max 80 characters)' }, { status: 400 });
  }

  try {
    await assertWithinLimit(auth.workspace, 'widgets', (await listWidgets(auth.workspace.id)).length);
    return NextResponse.json({ widget: await createWidget(auth.workspace.id, name) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/widgets POST', []);
  }
}
