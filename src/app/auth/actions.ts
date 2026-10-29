'use server';

import { redirect } from 'next/navigation';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { hasWebsiteAccess } from '@/lib/auth';
import { WEBSITE_ID } from '@/lib/env';

export type AuthFormState = { error?: string; message?: string; email?: string; fullName?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Throwaway inboxes would let one person collect unlimited free demo minutes
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com',
  'temp-mail.org', 'tempmail.com', 'tempmail.net', 'yopmail.com', 'trashmail.com', 'getnada.com',
  'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
  'emailondeck.com', 'mohmal.com', 'tempinbox.com', 'mailnesia.com', 'spamgourmet.com', 'moakt.com',
]);

function safeNext(next: FormDataEntryValue | null): string | null {
  const value = typeof next === 'string' ? next : '';
  return value.startsWith('/') && !value.startsWith('//') ? value : null;
}

/** Where to go after signing in. Platform pages re-check the role, so any local path is safe here. */
function landingPath(next: string | null): string {
  return next ?? '/dashboard';
}

/**
 * Login is per website: credentials are global across the shared Supabase project,
 * so a valid password alone isn't enough. Accounts without a Voice Agent role are
 * signed out and sent to sign up.
 */
export async function loginAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  if (!EMAIL_RE.test(email) || !password) return { error: 'Enter your email and password.', email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: 'Incorrect email or password.', email };

  const next = safeNext(formData.get('next'));
  if (!(await hasWebsiteAccess(data.user.id))) {
    await supabase.auth.signOut();
    const nextParam = next ? `&next=${encodeURIComponent(next)}` : '';
    redirect(`/signup?email=${encodeURIComponent(email)}&notice=not_registered${nextParam}`);
  }

  redirect(landingPath(next));
}

/**
 * Signup enrolls the account into this website with the "user" role.
 * Existing accounts from other websites must prove ownership with their password.
 * Admin rights are never granted here.
 */
export async function signupAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const keep = { email, fullName };

  if (!fullName) return { error: 'Enter your name.', ...keep };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.', ...keep };
  if (password.length < 8) return { error: 'Password must be at least 8 characters.', ...keep };
  if (DISPOSABLE_DOMAINS.has(email.split('@')[1])) {
    return { error: 'Please use your work or personal email, not a temporary inbox.', ...keep };
  }

  const supabase = await createClient();
  let userId: string;
  let hasSession: boolean;

  const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });

  const alreadyExists =
    signUpErr?.code === 'user_already_exists' ||
    /already registered/i.test(signUpErr?.message ?? '') ||
    (signUp.user && signUp.user.identities?.length === 0);

  if (alreadyExists) {
    // Account exists (likely from another website): verify the password before enrolling
    const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr || !signIn.user) {
      return {
        error:
          'An account with this email already exists. Enter that account’s password to activate Voice Agent.',
        ...keep,
      };
    }
    userId = signIn.user.id;
    hasSession = true;
  } else if (signUpErr || !signUp.user) {
    return { error: signUpErr?.message ?? 'Sign up failed. Please try again.', ...keep };
  } else {
    userId = signUp.user.id;
    hasSession = Boolean(signUp.session);
  }

  if (!(await hasWebsiteAccess(userId))) {
    const { error: enrollErr } = await createAdminClient().rpc('enroll_user_in_website', {
      p_website_id: WEBSITE_ID,
      p_user_id: userId,
      p_role_name: 'user',
      p_full_name: fullName,
    });
    if (enrollErr) {
      console.error('[signup] enrollment failed', enrollErr);
      await supabase.auth.signOut();
      return { error: 'Your account was created but activation failed. Please try again.', ...keep };
    }
  }

  if (!hasSession) {
    return { message: 'Check your email to confirm your account, then log in.', email };
  }

  redirect(landingPath(safeNext(formData.get('next'))));
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
