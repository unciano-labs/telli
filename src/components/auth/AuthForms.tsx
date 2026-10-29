'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Loader2 } from 'lucide-react';
import { loginAction, signupAction, type AuthFormState } from '@/app/auth/actions';

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 read-only:bg-slate-50 read-only:text-slate-500';

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...input } = props;
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input {...input} className={inputCls} />
    </label>
  );
}

function Alert({ state, notice }: { state: AuthFormState; notice?: string }) {
  const text = state.error ?? state.message ?? notice;
  if (!text) return null;
  const isError = Boolean(state.error);
  return (
    <p
      role={isError ? 'alert' : 'status'}
      className={`rounded-lg px-3 py-2 text-sm ${isError ? 'bg-red-50 text-red-700' : 'bg-indigo-50 text-indigo-700'}`}
    >
      {text}
    </p>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-60"
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <Alert state={state} notice={notice} />
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="Email" name="email" type="email" autoComplete="email" required defaultValue={state.email} />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <SubmitButton pending={pending}>Log in</SubmitButton>
      <p className="text-center text-sm text-slate-500">
        New to Voice Agent?{' '}
        <Link
          href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}
          className="font-medium text-indigo-600 hover:text-indigo-500"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignupForm({ email, notice, next }: { email?: string; notice?: string; next?: string }) {
  const [state, action, pending] = useActionState(signupAction, {});
  const lockedEmail = email && !state.email ? email : undefined;
  return (
    <form action={action} className="space-y-4">
      <Alert state={state} notice={notice} />
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="Full name" name="fullName" autoComplete="name" required defaultValue={state.fullName} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state.email ?? email}
        readOnly={Boolean(lockedEmail)}
      />
      <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} required />
      <SubmitButton pending={pending}>Create account</SubmitButton>
      <p className="text-center text-sm text-slate-500">
        Already registered?{' '}
        <Link
          href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
          className="font-medium text-indigo-600 hover:text-indigo-500"
        >
          Log in
        </Link>
      </p>
    </form>
  );
}
