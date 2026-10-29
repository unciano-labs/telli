import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { AudioLines } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { isWebsiteAdmin } from '@/lib/auth';
import { logoutAction } from '@/app/auth/actions';

async function AccountLinks() {
  // Auth reads the clock (token expiry); keep it out of prerender
  await connection();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Link href="/login" className="text-sm font-medium text-slate-600 hover:text-slate-900">
        Log in
      </Link>
    );
  }

  const isAdmin = await isWebsiteAdmin(user.id);
  return (
    <div className="flex items-center gap-4 text-sm">
      {isAdmin && (
        <Link href="/platform" className="font-medium text-slate-600 hover:text-slate-900">
          Platform
        </Link>
      )}
      <Link href="/dashboard" className="font-medium text-indigo-600 hover:text-indigo-500">
        Dashboard
      </Link>
      <form action={logoutAction}>
        <button className="text-slate-600 hover:text-slate-900">Log out</button>
      </form>
    </div>
  );
}

export default function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <AudioLines className="h-4 w-4" />
        </span>
        Voice Support
      </Link>
      <div className="flex items-center gap-5">
        <Link href="/demo" className="text-sm font-medium text-slate-600 hover:text-slate-900">
          Try the demo
        </Link>
        <Suspense fallback={null}>
          <AccountLinks />
        </Suspense>
      </div>
    </header>
  );
}
