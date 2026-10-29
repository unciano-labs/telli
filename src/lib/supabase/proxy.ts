import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Signed-in members: dashboards and workspaces (handlers check the workspace role)
const MEMBER_PAGE = /^\/(dashboard|onboarding|w)(\/|$)/;
const MEMBER_API = /^\/api\/(w|workspaces|invites)(\/|$)/;
// Website admins only (platform staff)
const PLATFORM_PAGE = /^\/platform(\/|$)/;
const PLATFORM_API = /^\/api\/platform(\/|$)/;

/**
 * Refreshes the Supabase session cookie and guards private routes.
 * Unauthenticated: pages -> redirect to /login, APIs -> 401.
 * Platform routes also need the website admin role: pages -> /dashboard, APIs -> 403.
 * Route handlers re-check (workspace roles included); this is the first line of defense.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    }
  );

  // Do not run code between createServerClient and getUser(): it refreshes the session.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPlatform = PLATFORM_PAGE.test(pathname) || PLATFORM_API.test(pathname);
  const isApi = MEMBER_API.test(pathname) || PLATFORM_API.test(pathname);
  if (!isPlatform && !isApi && !MEMBER_PAGE.test(pathname)) return response;

  if (!user) {
    if (isApi) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  if (!isPlatform) return response;

  const { data: isAdmin } = await supabase.rpc('is_admin', {
    p_website_id: process.env.WEBSITE_ID,
    p_user_id: user.id,
  });

  if (isAdmin !== true) {
    if (isApi) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}
