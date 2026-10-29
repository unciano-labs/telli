import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { workspaceRoute } from '@/lib/route-auth';
import { deleteWidget, updateWidget, validateWidgetUpdate, WidgetError } from '@/lib/widgets';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ slug: string; id: string }> };

function errorResponse(error: unknown, label: string) {
  if (error instanceof WidgetError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`[w/widgets ${label}]`, error);
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

/** Body: any of { name, title, button_label, accent_color, position, enabled, allowed_origins[] }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid widget id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  try {
    return NextResponse.json({ widget: await updateWidget(auth.workspace.id, id, validateWidgetUpdate(body)) });
  } catch (error) {
    return errorResponse(error, 'PATCH');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid widget id' }, { status: 400 });

  try {
    await deleteWidget(auth.workspace.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'DELETE');
  }
}
