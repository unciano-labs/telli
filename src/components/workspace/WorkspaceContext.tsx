'use client';

import { createContext, useContext } from 'react';
import type { WorkspaceRole, WorkspaceStatus } from '@/lib/workspace-roles';
import type { ModuleId } from '@/lib/modules-shared';

export type WorkspaceInfo = {
  slug: string;
  name: string;
  role: WorkspaceRole;
  status: WorkspaceStatus;
  isPlatform: boolean;
  /** Modules that are on (reservations, rentals): the Bookings tab shows only with one. */
  modules: ModuleId[];
};

const WorkspaceContext = createContext<WorkspaceInfo | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceInfo; children: React.ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceInfo {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside a workspace page');
  return value;
}

/** Base path of the current workspace's API, e.g. /api/w/acme-dental. */
export function useWorkspaceApi() {
  return `/api/w/${useWorkspace().slug}`;
}
