import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { isWebsiteAdmin } from '@/lib/auth';
import { TwilioError } from '@/lib/twilio';
import { NumberError, searchTwilioNumbers } from '@/lib/phone-numbers';

/** Query: ?country=US&area_code=415. Numbers for sale on our Twilio account (website admins). */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  if (!(await isWebsiteAdmin(auth.user.id))) {
    return NextResponse.json({ error: 'Buying a number isn’t available yet. Contact us to add one.' }, { status: 403 });
  }
  const query = new URL(req.url).searchParams;
  try {
    const offers = await searchTwilioNumbers((query.get('country') ?? 'US').toUpperCase(), query.get('area_code')?.trim() || null);
    return NextResponse.json({ offers });
  } catch (error) {
    return errorResponse(error, 'w/numbers/search GET', [NumberError, TwilioError]);
  }
}
