import { NextResponse } from 'next/server';
import { authorizeAdmin } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { findWorkspaceById, updateWorkspaceAdmin, WorkspaceError } from '@/lib/workspaces';
import { BillingError, grantMonth } from '@/lib/billing';
import { WORKSPACE_STATUSES, type WorkspaceStatus } from '@/lib/workspace-roles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRIAL_MINUTES = 6000;

/** Body: any of { status, trial_minutes } or { grant_plan } (one free month). Platform staff only. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (typeof body?.grant_plan === 'string') {
    try {
      const workspace = await findWorkspaceById(id);
      if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      await grantMonth(workspace, body.grant_plan, auth.user.id);
      return NextResponse.json({ workspace: await findWorkspaceById(id) });
    } catch (error) {
      if (error instanceof BillingError) return NextResponse.json({ error: error.message }, { status: error.status });
      console.error('[platform/workspaces PATCH grant]', error);
      return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
    }
  }
  const update: { status?: WorkspaceStatus; trial_seconds?: number } = {};
  if (body?.status !== undefined) {
    if (!WORKSPACE_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    update.status = body.status;
  }
  if (body?.trial_minutes !== undefined) {
    const minutes = Number(body.trial_minutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_TRIAL_MINUTES) {
      return NextResponse.json({ error: `Trial minutes must be 0–${MAX_TRIAL_MINUTES}` }, { status: 400 });
    }
    update.trial_seconds = minutes * 60;
  }
  if (!Object.keys(update).length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  try {
    return NextResponse.json({ workspace: await updateWorkspaceAdmin(id, update) });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[platform/workspaces PATCH]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
