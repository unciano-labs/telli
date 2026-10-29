import Link from 'next/link';
import { AudioLines } from 'lucide-react';

export default function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white">
          <AudioLines className="h-5 w-5" />
        </Link>
        <h1 className="mt-6 text-center text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-1 text-center text-sm text-slate-500">{subtitle}</p>
        <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">{children}</div>
      </div>
    </main>
  );
}
