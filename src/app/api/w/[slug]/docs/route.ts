import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { workspaceRoute } from '@/lib/route-auth';
import { deleteDocument, ingestDocument, KbError, listDocuments } from '@/lib/knowledge-base';

type Params = { params: Promise<{ slug: string }> };

function errorResponse(error: unknown, label: string) {
  if (error instanceof KbError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`[w/docs ${label}]`, error);
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ documents: await listDocuments(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'GET');
  }
}

/** Body: { storagePath, fileName } for a file already uploaded via ./upload-url. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const storagePath = typeof body?.storagePath === 'string' ? body.storagePath : '';
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
  if (!storagePath || !fileName) {
    return NextResponse.json({ error: 'storagePath and fileName are required' }, { status: 400 });
  }

  try {
    const document = await ingestDocument(auth.workspace, { storagePath, fileName }, auth.user.id);
    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'POST');
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const id = new URL(req.url).searchParams.get('id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'A valid document id is required' }, { status: 400 });
  }

  try {
    await deleteDocument(auth.workspace, id, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'DELETE');
  }
}
