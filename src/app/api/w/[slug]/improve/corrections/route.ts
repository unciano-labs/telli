import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { KbError } from '@/lib/knowledge-base';
import { DraftError } from '@/lib/agent-draft';
import {
  applyCorrection,
  createCorrection,
  dismissCorrection,
  ImproveError,
  listCorrections,
  validateCorrection,
  validateFix,
} from '@/lib/improve';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ERRORS = [ImproveError, KbError, DraftError];

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ corrections: await listCorrections(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/improve/corrections GET', APP_ERRORS);
  }
}

/**
 * Body: { fix_type: 'faq' | 'rule', question?, correction, call_log_id + position | question_ids[] }.
 * Owners and admins apply the fix at once; members' fixes are saved as suggestions.
 */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    const correction = await createCorrection(auth.workspace, auth.user.id, auth.role, validateCorrection(body));
    return NextResponse.json({ correction }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/improve/corrections POST', APP_ERRORS);
  }
}

/** Query: ?id=… Body: { action: 'apply', fix_type, question?, correction } or { action: 'dismiss' }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'A valid fix id is required' }, { status: 400 });
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    if (body.action === 'dismiss') {
      await dismissCorrection(auth.workspace, auth.user.id, id);
      return new NextResponse(null, { status: 204 });
    }
    if (body.action !== 'apply') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    // The reviewer may edit the fix; the link to its call or questions can't change
    const applied = await applyCorrection(auth.workspace, auth.user.id, id, validateFix(body));
    return NextResponse.json({ correction: applied });
  } catch (error) {
    return errorResponse(error, 'w/improve/corrections PATCH', APP_ERRORS);
  }
}
