import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { workspaceRoute } from '@/lib/route-auth';
import { createSignedUpload, KbError } from '@/lib/knowledge-base';
import { BillingError } from '@/lib/billing';

/** Body: { fileName, fileSize }. Returns a signed Storage upload slot in the workspace's folder. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
  const fileSize = Number(body?.fileSize);

  try {
    return NextResponse.json(await createSignedUpload(auth.workspace, fileName, fileSize));
  } catch (error) {
    if (error instanceof KbError || error instanceof BillingError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[w/docs/upload-url]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
