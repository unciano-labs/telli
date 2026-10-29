'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Bot, CalendarCheck, CreditCard, PanelBottom, Phone, PhoneOutgoing, Users } from 'lucide-react';
import { useWorkspace } from '@/components/workspace/WorkspaceContext';
import { hasRole, type WorkspaceRole } from '@/lib/workspace-roles';

const TABS: { path: string; label: string; icon: typeof Bot; minimum: WorkspaceRole; needsModule?: boolean }[] = [
  { path: '', label: 'Agent', icon: Bot, minimum: 'member' },
  { path: '/bookings', label: 'Bookings', icon: CalendarCheck, minimum: 'member', needsModule: true },
  { path: '/widgets', label: 'Widgets', icon: PanelBottom, minimum: 'admin' },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, minimum: 'member' },
  { path: '/numbers', label: 'Phone numbers', icon: Phone, minimum: 'admin' },
  { path: '/outbound', label: 'Outbound', icon: PhoneOutgoing, minimum: 'admin' },
  { path: '/team', label: 'Team', icon: Users, minimum: 'member' },
  { path: '/billing', label: 'Billing', icon: CreditCard, minimum: 'owner' },
];

// Agent studio pages besides the Profile page at the workspace root
const STUDIO = ['/knowledge', '/modules', '/test', '/improve', '/history'];

export default function WorkspaceNav() {
  const pathname = usePathname();
  const { slug, role, modules } = useWorkspace();
  const base = `/w/${slug}`;

  return (
    <nav aria-label="Workspace" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1 border-b border-slate-200">
        {TABS.filter((t) => hasRole(role, t.minimum) && (!t.needsModule || modules.length > 0)).map(({ path, label, icon: Icon }) => {
          // Members land on the studio's Test page; Profile and Knowledge need admin
          const href = base + (path === '' && !hasRole(role, 'admin') ? '/test' : path);
          const active = path === '' ? pathname === base || STUDIO.some((p) => pathname === base + p) : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition ${active ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
