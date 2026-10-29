import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/retell';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { findWidgetByKey } from '@/lib/widgets';
import { widgetRequestError } from '@/lib/widget-request';
import { normalizePageUrl } from '@/lib/widget-config';
import { recordCallFeedback } from '@/lib/improve';

const MAX_FEEDBACK = 10;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_COMMENT = 1000;

/**
 * Body: { callId, rating: 'up' | 'down', comment?, pageUrl }. The caller's rating of a call
 * this widget started, once per call within an hour. Always answers 204 to the widget.
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const noContent = new NextResponse(null, { status: 204 });
  if (!rateLimit(`widget-feedback:${getClientIp(req.headers)}`, MAX_FEEDBACK, WINDOW_MS).allowed) return noContent;

  const body = await req.json().catch(() => null);
  const rating = body?.rating;
  const callId = typeof body?.callId === 'string' ? body.callId : '';
  if ((rating !== 'up' && rating !== 'down') || !/^call_[a-z0-9]{8,64}$/i.test(callId)) {
    return NextResponse.json({ error: 'Invalid feedback' }, { status: 400 });
  }
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, MAX_COMMENT) || null : null;

  try {
    const widget = await findWidgetByKey(key);
    if (!widget || !widget.enabled || widgetRequestError(req, widget, normalizePageUrl(body?.pageUrl))) return noContent;
    await recordCallFeedback({ widgetId: widget.id, retellCallId: callId, rating, comment });
  } catch (error) {
    console.error('[widget/feedback]', key, errorMessage(error));
  }
  return noContent;
}
