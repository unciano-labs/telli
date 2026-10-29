import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { DraftError, publishDraft } from '@/lib/agent-draft';

/** Body: { note }. Publishes the draft so callers hear it. Owners and admins only. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : '';
  try {
    return NextResponse.json({ config: await publishDraft(auth.workspace, auth.user.id, note) });
  } catch (error) {
    return errorResponse(error, 'w/publish', [DraftError]);
  }
}
