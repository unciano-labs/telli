import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { rateLimit } from '@/lib/rate-limit';
import { workspaceRoute } from '@/lib/route-auth';
import { AgentNotConfiguredError, startWebCall } from '@/lib/web-calls';
import { normalizePageUrl } from '@/lib/widget-config';
import { callBlockedMessage, CallBlockedError } from '@/lib/billing';

const MAX_CALLS = 10;
const WINDOW_MS = 10 * 60 * 1000;

/** Body: { pageUrl }. A browser call to the draft agent, logged as a test (kept out of analytics). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // Members can test too; the trial guard and the rate limit bound the minutes
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;

  const limit = rateLimit(`test-call:${auth.user.id}`, MAX_CALLS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many test calls. Try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);
  try {
    const token = await startWebCall({
      workspace: auth.workspace,
      source: 'test',
      version: 'draft',
      pageUrl: normalizePageUrl(body?.pageUrl),
      userId: auth.user.id,
    });
    return NextResponse.json(token);
  } catch (error) {
    if (error instanceof CallBlockedError) {
      return NextResponse.json({ error: callBlockedMessage(error) }, { status: 403 });
    }
    if (error instanceof AgentNotConfiguredError) {
      return NextResponse.json({ error: 'Open the Agent tab once to finish setting up the agent.' }, { status: 409 });
    }
    console.error('[w/test-call]', errorMessage(error));
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}
