import { NextResponse } from 'next/server';
import { authorizeMember } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { DemoError, startDemoCall } from '@/lib/demo';
import { isDemoLanguage, isDemoScenario } from '@/lib/demo-config';
import { normalizePageUrl } from '@/lib/widget-config';

const MAX_STARTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

/** Body: { scenario, language ("multi" | "fil", default multi), pageUrl }. Starts a demo call capped to the user's remaining free time. */
export async function POST(req: Request) {
  const auth = await authorizeMember();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Allowances bound the minutes; this bounds hammering the endpoint
  for (const bucket of [`demo:${auth.user.id}`, `demo-ip:${getClientIp(req.headers)}`]) {
    const limit = rateLimit(bucket, MAX_STARTS, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many attempts. Please wait a few minutes.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
      );
    }
  }

  const body = await req.json().catch(() => null);
  if (!isDemoScenario(body?.scenario)) {
    return NextResponse.json({ error: 'Choose a demo scenario' }, { status: 400 });
  }

  try {
    const { token, allottedSeconds } = await startDemoCall({
      userId: auth.user.id,
      scenario: body.scenario,
      language: isDemoLanguage(body?.language) ? body.language : 'multi',
      pageUrl: normalizePageUrl(body?.pageUrl),
    });
    return NextResponse.json({ ...token, allotted_seconds: allottedSeconds });
  } catch (error) {
    if (error instanceof DemoError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[demo/call]', errorMessage(error));
    return NextResponse.json({ error: 'Could not start the demo. Please try again shortly.' }, { status: 500 });
  }
}
