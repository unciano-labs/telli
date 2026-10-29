import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { BillingError, startCheckout } from '@/lib/billing';
import { PayMongoError } from '@/lib/paymongo';

/** Body: { plan }. Owners: starts a PayMongo checkout for one month and returns its URL. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'owner');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  const plan = typeof body.plan === 'string' ? body.plan : '';
  // Where PayMongo sends the owner back: this deployment's own address
  const appUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, '') || new URL(req.url).origin;
  try {
    return NextResponse.json({ url: await startCheckout(auth.workspace, auth.user.id, plan, appUrl) });
  } catch (error) {
    return errorResponse(error, 'w/billing POST', [BillingError, PayMongoError]);
  }
}
