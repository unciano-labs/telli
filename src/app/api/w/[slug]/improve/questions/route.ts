import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { ignoreQuestions, ImproveError, listQuestionGroups, validateIds } from '@/lib/improve';

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ groups: await listQuestionGroups(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/improve/questions GET', [ImproveError]);
  }
}

/**
 * Body: { action: 'ignore', ids[] }. Answers go through /improve/corrections with
 * question_ids, so members can suggest them and owners/admins apply them the same way.
 */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    if (body.action !== 'ignore') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    await ignoreQuestions(auth.workspace, auth.user.id, validateIds(body.ids));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'w/improve/questions POST', [ImproveError]);
  }
}
