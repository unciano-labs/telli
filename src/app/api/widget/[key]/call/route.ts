import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { findWidgetByKey } from '@/lib/widgets';
import { isAppPage, widgetRequestError } from '@/lib/widget-request';
import { AgentNotConfiguredError, startWebCall } from '@/lib/web-calls';
import { normalizePageUrl, normalizeVisitorId } from '@/lib/widget-config';
import { findWorkspaceById } from '@/lib/workspaces';
import { callBlockedMessage, CallBlockedError } from '@/lib/billing';

const IP_LIMIT = 5;
const IP_WINDOW_MS = 10 * 60 * 1000;
const WIDGET_LIMIT = 60;
const WIDGET_WINDOW_MS = 60 * 60 * 1000;

/** Body: { visitorId, pageUrl, preview }. Starts a call from an embedded widget. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const body = await req.json().catch(() => null);
  const pageUrl = normalizePageUrl(body?.pageUrl);

  try {
    const widget = await findWidgetByKey(key);
    if (!widget || !widget.enabled) {
      return NextResponse.json({ error: 'This widget is not available.' }, { status: 404 });
    }
    const rejected = widgetRequestError(req, widget, pageUrl);
    if (rejected) return NextResponse.json({ error: rejected }, { status: 403 });

    for (const [bucket, max, windowMs] of [
      [`widget-call:${getClientIp(req.headers)}`, IP_LIMIT, IP_WINDOW_MS],
      [`widget-call:${widget.id}`, WIDGET_LIMIT, WIDGET_WINDOW_MS],
    ] as const) {
      const limit = rateLimit(bucket, max, windowMs);
      if (!limit.allowed) {
        return NextResponse.json(
          { error: 'Too many calls started. Please try again later.' },
          { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
        );
      }
    }

    const workspace = await findWorkspaceById(widget.workspace_id);
    if (!workspace) return NextResponse.json({ error: 'This widget is not available.' }, { status: 404 });

    const token = await startWebCall({
      workspace,
      // Admin preview calls are kept out of widget analytics
      source: body?.preview === true && isAppPage(req, pageUrl) ? 'test' : 'widget',
      widgetId: widget.id,
      pageUrl,
      visitorId: normalizeVisitorId(body?.visitorId),
    });
    return NextResponse.json(token);
  } catch (error) {
    if (error instanceof AgentNotConfiguredError) {
      return NextResponse.json({ error: 'The voice agent is not configured yet.' }, { status: 503 });
    }
    if (error instanceof CallBlockedError) {
      // Visitors don't need the reason (trial or suspension); the preview shows it to the admin
      const preview = body?.preview === true && isAppPage(req, pageUrl);
      return NextResponse.json(
        { error: preview ? callBlockedMessage(error) : 'The agent isn’t taking calls right now. Please try again later.' },
        { status: 503 }
      );
    }
    console.error('[widget/call]', key, errorMessage(error));
    return NextResponse.json({ error: 'Could not start the call. Please try again shortly.' }, { status: 500 });
  }
}
