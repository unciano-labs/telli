import { NextResponse } from 'next/server';
import { authorizeAdmin } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { DemoError, updateDemoSettings, validateDemoSettings } from '@/lib/demo';

/** Body: any of { enabled, seconds_per_user, daily_budget_minutes, contact_url }. */
export async function PATCH(req: Request) {
  const auth = await authorizeAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  try {
    return NextResponse.json({ settings: await updateDemoSettings(validateDemoSettings(body)) });
  } catch (error) {
    if (error instanceof DemoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[platform/demo PATCH]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
