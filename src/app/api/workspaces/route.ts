import { NextResponse } from 'next/server';
import { authorizeMember } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { rateLimit } from '@/lib/rate-limit';
import { getOrProvisionAgentConfig } from '@/lib/agent-config';
import { createWorkspace, listUserWorkspaces, WorkspaceError } from '@/lib/workspaces';
import { setUpModules } from '@/lib/bookings';
import { MODULES, type ModuleId } from '@/lib/modules-shared';

const MAX_CREATES = 5;
const WINDOW_MS = 60 * 60 * 1000;

export async function GET() {
  const auth = await authorizeMember();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    return NextResponse.json({ workspaces: await listUserWorkspaces(auth.user.id) });
  } catch (error) {
    console.error('[workspaces GET]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

/**
 * Body: { name, template, modules?: ModuleId[], samples?: boolean, timezone? }. Creates a workspace
 * owned by the user, turns on the chosen modules (with sample data to try), and sets up its agent.
 */
export async function POST(req: Request) {
  const auth = await authorizeMember();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!rateLimit(`workspace-create:${auth.user.id}`, MAX_CREATES, WINDOW_MS).allowed) {
    return NextResponse.json({ error: 'Too many workspaces created. Try again later.' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : '';
  const template = typeof body?.template === 'string' ? body.template : '';
  const modules = (Array.isArray(body?.modules) ? body.modules : []).filter((m: unknown): m is ModuleId => typeof m === 'string' && m in MODULES);
  const timezone = typeof body?.timezone === 'string' ? body.timezone : '';

  let workspace;
  try {
    workspace = await createWorkspace({ userId: auth.user.id, name, template });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[workspaces POST]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }

  // Before the agent: it's created with the modules' prompt and functions
  if (modules.length) {
    await setUpModules(workspace, [...new Set(modules)] as ModuleId[], body?.samples !== false, timezone).catch((error) =>
      console.error('[workspaces POST] module setup failed', workspace.slug, errorMessage(error))
    );
  }

  // The Agent page retries this on load, so a Retell hiccup doesn't lose the workspace
  const agentReady = await getOrProvisionAgentConfig(workspace).then(
    () => true,
    (error) => {
      console.error('[workspaces POST] agent setup failed', workspace.slug, errorMessage(error));
      return false;
    }
  );
  return NextResponse.json({ workspace, agentReady }, { status: 201 });
}
