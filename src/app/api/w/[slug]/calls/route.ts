import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { rateLimit } from '@/lib/rate-limit';
import { workspaceRoute } from '@/lib/route-auth';
import { OutboundError, startOutboundCall } from '@/lib/outbound';
import { listCallLogs, type CallSource } from '@/lib/call-logs';
import { BillingError, callBlockedMessage, CallBlockedError } from '@/lib/billing';

const SOURCES: CallSource[] = ['landing', 'widget', 'demo', 'test', 'outbound', 'inbound'];

const MAX_CALLS = 10;
const WINDOW_MS = 10 * 60 * 1000;

type Params = { params: Promise<{ slug: string }> };

function errorResponse(error: unknown, label: string) {
  if (error instanceof OutboundError || error instanceof BillingError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof CallBlockedError) {
    return NextResponse.json({ error: callBlockedMessage(error) }, { status: 403 });
  }
  console.error(`[w/calls ${label}]`, error);
  return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
}

/** Query: ?source=widget|outbound|… (optional), ?limit=1-50 (default 20). Members can read. */
export async function GET(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;

  const query = new URL(req.url).searchParams;
  const source = query.get('source') as CallSource | null;
  if (source && !SOURCES.includes(source)) {
    return NextResponse.json({ error: 'Unknown source' }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(query.get('limit')) || 20, 1), 50);

  try {
    const calls = await listCallLogs({ workspaceId: auth.workspace.id, limit, source: source ?? undefined });
    return NextResponse.json({ calls });
  } catch (error) {
    return errorResponse(error, 'GET');
  }
}

/** Body: { toNumber, customerName?, reason }. Starts an outbound phone call. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const limit = rateLimit(`outbound:${auth.user.id}`, MAX_CALLS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Outbound call limit reached (${MAX_CALLS} per 10 minutes). Try again later.` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const toNumber = str(body?.toNumber, 32);
  const customerName = str(body?.customerName, 80);
  const reason = str(body?.reason, 200);
  if (!toNumber) return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
  if (!reason) return NextResponse.json({ error: 'Reason for the call is required' }, { status: 400 });

  try {
    const call = await startOutboundCall(auth.workspace, {
      toNumber,
      customerName,
      reason,
      initiatedBy: auth.user.id,
    });
    return NextResponse.json({ call }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'POST');
  }
}
