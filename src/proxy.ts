import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/proxy';
import { getFrameAncestors } from '@/lib/widgets';

const EMBED_PAGE = /^\/embed\/([^/]+)\/?$/;
// Pre-workspace admin URLs
const LEGACY_ADMIN = /^\/admin(\/(widgets|analytics|outbound|demo))?\/?$/;
// Called from customer sites or by Retell: no session to refresh
const SESSIONLESS = /^\/(embed|api\/widget|api\/webhooks)\//;

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const embed = EMBED_PAGE.exec(pathname);
  if (embed) {
    // Only the widget's allowed sites (and this app, for the admin preview) may frame it
    const origins = await getFrameAncestors(decodeURIComponent(embed[1]));
    const response = NextResponse.next();
    response.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${origins.join(' ')}`.trim());
    return response;
  }
  if (SESSIONLESS.test(pathname)) return NextResponse.next();

  const legacy = LEGACY_ADMIN.exec(pathname);
  if (legacy || pathname.startsWith('/admin/')) {
    const url = request.nextUrl.clone();
    url.pathname = legacy?.[2] === 'demo' ? '/platform/demo' : '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and images
    '/((?!_next/static|_next/image|favicon.ico|widget.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
