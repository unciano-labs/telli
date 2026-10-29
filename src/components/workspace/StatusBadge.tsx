import type { WorkspaceStatus } from '@/lib/workspace-roles';

const STYLES: Record<WorkspaceStatus, { label: string; cls: string }> = {
  trial: { label: 'Trial', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  active: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  suspended: { label: 'Suspended', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
};

export default function StatusBadge({ status }: { status: WorkspaceStatus }) {
  const { label, cls } = STYLES[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      {label}
    </span>
  );
}
