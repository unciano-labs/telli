import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { AgentNotConfiguredError, startWebCall } from '@/lib/web-calls';
import { getPlatformWorkspace } from '@/lib/workspaces';
import { CallBlockedError } from '@/lib/billing';
import { normalizePageUrl, normalizeVisitorId } from '@/lib/widget-config';

const MAX_CALLS = 5;
const WINDOW_MS = 10 * 60 * 1000;

/** Body (optional): { visitorId, pageUrl }. Starts a call from the landing page dialer. */
export async function POST(req: Request) {
  const ip = getClientIp(req.headers);
  const limit = rateLimit(`call:${ip}`, MAX_CALLS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many calls started. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);

  try {
    // The landing dialer is this site's own support line
    const token = await startWebCall({
      workspace: await getPlatformWorkspace(),
      source: 'landing',
      pageUrl: normalizePageUrl(body?.pageUrl),
      visitorId: normalizeVisitorId(body?.visitorId),
    });
    return NextResponse.json(token);
  } catch (error) {
    if (error instanceof AgentNotConfiguredError || error instanceof CallBlockedError) {
      return NextResponse.json({ error: 'The voice agent is not configured yet.' }, { status: 503 });
    }
    // Public endpoint: log details, show visitors a generic message
    console.error('[call/create]', errorMessage(error));
    return NextResponse.json({ error: 'Could not start the call. Please try again shortly.' }, { status: 500 });
  }
}
