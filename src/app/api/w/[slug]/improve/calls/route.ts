import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { ImproveError, listReviewCalls, setCallReviewed } from '@/lib/improve';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query: ?filter=needs_review|all. Recent real calls with transcripts, worst first. */
export async function GET(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  const filter = new URL(req.url).searchParams.get('filter') === 'all' ? 'all' : 'needs_review';
  try {
    return NextResponse.json({ calls: await listReviewCalls(auth.workspace, filter) });
  } catch (error) {
    return errorResponse(error, 'w/improve/calls GET', [ImproveError]);
  }
}

/** Query: ?id=… Body: { reviewed: boolean }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'A valid call id is required' }, { status: 400 });
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    await setCallReviewed(auth.workspace, auth.user.id, id, body.reviewed !== false);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'w/improve/calls PATCH', [ImproveError]);
  }
}
