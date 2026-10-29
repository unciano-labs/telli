import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { workspaceRoute } from '@/lib/route-auth';
import { OutboundError, updateOutboundSettings } from '@/lib/outbound';

/** Body: { retell_phone_number, outbound_begin_message }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const phone = typeof body?.retell_phone_number === 'string' ? body.retell_phone_number.trim() : '';
  const greeting = typeof body?.outbound_begin_message === 'string' ? body.outbound_begin_message.trim() : '';
  if (!greeting || greeting.length > 500) {
    return NextResponse.json({ error: 'Outbound greeting is required (max 500 characters)' }, { status: 400 });
  }

  try {
    const settings = await updateOutboundSettings(auth.workspace, {
      retell_phone_number: phone || null,
      outbound_begin_message: greeting,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof OutboundError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[w/outbound PATCH]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
