import 'server-only';
import { originAllowed, type Widget } from '@/lib/widgets';

/**
 * Checks a request made from inside the widget iframe. The iframe is served from this
 * app, so browsers send `Sec-Fetch-Site: same-origin`; the page embedding it (sent by
 * the iframe as pageUrl) must be on the widget's allow-list, or this app itself (admin preview).
 * The CSP frame-ancestors header is the real enforcement; this rejects direct cross-site use.
 */
export function widgetRequestError(req: Request, widget: Widget, pageUrl: string | null): string | null {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') return 'Cross-site requests are not allowed';
  if (!pageUrl) return 'Missing page URL';

  const pageOrigin = new URL(pageUrl).origin;
  if (pageOrigin === new URL(req.url).origin) return null;
  return originAllowed(pageOrigin, widget.allowed_origins) ? null : 'This website is not allowed to use the widget';
}

export function isAppPage(req: Request, pageUrl: string | null) {
  return pageUrl !== null && new URL(pageUrl).origin === new URL(req.url).origin;
}
