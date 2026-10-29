import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { DraftError } from '@/lib/agent-draft';
import { BookingError, listRentals, listServices, updateModule } from '@/lib/bookings';
import { getModuleStates } from '@/lib/modules-agent';
import { MODULES, type ModuleId } from '@/lib/modules-shared';
import { publicAppUrl } from '@/lib/public-url';

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  try {
    const [modules, services, rentals] = await Promise.all([
      getModuleStates(auth.workspace.id),
      listServices(auth.workspace.id),
      listRentals(auth.workspace.id),
    ]);
    return NextResponse.json({ modules, services, rentals, connected: Boolean(publicAppUrl()) });
  } catch (error) {
    return errorResponse(error, 'w/modules GET', [BookingError]);
  }
}

/** Body: { module, enabled?, settings? }. Turning a module on or off changes the draft. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  if (!(body.module in MODULES)) return NextResponse.json({ error: 'Unknown module' }, { status: 400 });
  try {
    const state = await updateModule(auth.workspace, auth.user.id, body.module as ModuleId, {
      ...(typeof body.enabled === 'boolean' && { enabled: body.enabled }),
      ...(body.settings && typeof body.settings === 'object' && { settings: body.settings }),
    });
    return NextResponse.json({ module: state });
  } catch (error) {
    return errorResponse(error, 'w/modules PATCH', [BookingError, DraftError]);
  }
}
