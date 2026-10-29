import { AlertTriangle, Loader2 } from 'lucide-react';

export function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function LoadError({ title, message, hint }: { title: string; message: string; hint?: string }) {
  return (
    <div className="flex gap-3 rounded-2xl bg-red-50 p-5 text-sm text-red-800 ring-1 ring-red-200">
      <AlertTriangle className="h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-1">{message}</p>
        {hint && <p className="mt-2 text-red-700">{hint}</p>}
      </div>
    </div>
  );
}

export const MIGRATION_HINT =
  'Check that RETELL_API_KEY is set and every SQL file in supabase/migrations has been run in the Supabase SQL Editor.';
