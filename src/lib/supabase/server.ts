import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/** Session-bound client (anon key + auth cookies). Create one per request. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component; the proxy refreshes the session instead.
          }
        },
      },
    }
  );
}

// Next.js memoizes identical GET fetches within a Server Component render, which
// returns stale rows for read-after-write. A per-request AbortSignal opts out.
const unmemoizedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? new AbortController().signal });

/** Service-role client. Bypasses RLS: only use after authorizing the request. */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: unmemoizedFetch },
    }
  );
}
