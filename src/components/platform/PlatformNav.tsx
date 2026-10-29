'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, PlayCircle, Wallet } from 'lucide-react';

const TABS = [
  { href: '/platform', label: 'Workspaces', icon: Building2 },
  { href: '/platform/revenue', label: 'Revenue', icon: Wallet },
  { href: '/platform/demo', label: 'Demo', icon: PlayCircle },
];

export default function PlatformNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Platform" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1 border-b border-slate-200">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === '/platform' ? pathname === href : pathname.startsWith(href);
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
