'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Blocks, BookOpen, FlaskConical, History, Sparkles, UserRound } from 'lucide-react';
import { useWorkspace } from '@/components/workspace/WorkspaceContext';
import { hasRole, type WorkspaceRole } from '@/lib/workspace-roles';

const SECTIONS: { path: string; label: string; icon: typeof BookOpen; minimum: WorkspaceRole }[] = [
  { path: '', label: 'Profile', icon: UserRound, minimum: 'admin' },
  { path: '/knowledge', label: 'Knowledge', icon: BookOpen, minimum: 'admin' },
  { path: '/modules', label: 'Modules', icon: Blocks, minimum: 'admin' },
  { path: '/test', label: 'Test', icon: FlaskConical, minimum: 'member' },
  { path: '/improve', label: 'Improve', icon: Sparkles, minimum: 'member' },
  { path: '/history', label: 'History', icon: History, minimum: 'member' },
];

/** Sub-navigation of the agent studio (Teach → Test → Improve → History). */
export default function StudioNav() {
  const pathname = usePathname();
  const { slug, role } = useWorkspace();
  const base = `/w/${slug}`;
  return (
    <nav aria-label="Agent studio" className="flex flex-wrap gap-2">
      {SECTIONS.filter((s) => hasRole(role, s.minimum)).map(({ path, label, icon: Icon }) => {
        const href = base + path;
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${active ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900'}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
