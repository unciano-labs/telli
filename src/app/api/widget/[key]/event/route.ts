import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { findWidgetByKey, recordWidgetEvent, WIDGET_EVENTS, type WidgetEvent } from '@/lib/widgets';
import { widgetRequestError } from '@/lib/widget-request';
import { normalizePageUrl, normalizeVisitorId } from '@/lib/widget-config';

const MAX_EVENTS = 60;
const WINDOW_MS = 10 * 60 * 1000;

/** Body: { event, visitorId, pageUrl }. Funnel tracking; always answers 204 to the widget. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const noContent = new NextResponse(null, { status: 204 });

  if (!rateLimit(`widget-event:${getClientIp(req.headers)}`, MAX_EVENTS, WINDOW_MS).allowed) return noContent;

  const body = await req.json().catch(() => null);
  const event = body?.event as WidgetEvent;
  if (!WIDGET_EVENTS.includes(event)) return NextResponse.json({ error: 'Unknown event' }, { status: 400 });
  const pageUrl = normalizePageUrl(body?.pageUrl);

  try {
    const widget = await findWidgetByKey(key);
    if (!widget || !widget.enabled || widgetRequestError(req, widget, pageUrl)) return noContent;
    await recordWidgetEvent(widget, event, normalizeVisitorId(body?.visitorId), pageUrl);
  } catch (error) {
    console.error('[widget/event]', key, errorMessage(error));
  }
  return noContent;
}
