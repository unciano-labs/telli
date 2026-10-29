// Shared by server and client: role and status rules for workspaces.

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type WorkspaceStatus = 'trial' | 'active' | 'suspended';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member'];
export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['trial', 'active', 'suspended'];

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: 'Everything, including managing owners',
  admin: 'Agent, documents, widgets, calls and team',
  member: 'View analytics and calls',
};

const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

export function hasRole(role: WorkspaceRole, minimum: WorkspaceRole) {
  return RANK[role] >= RANK[minimum];
}

/** Roles an actor may hand out (invites or role changes). Only owners create owners. */
export function assignableRoles(actor: WorkspaceRole): WorkspaceRole[] {
  if (actor === 'owner') return ['owner', 'admin', 'member'];
  if (actor === 'admin') return ['admin', 'member'];
  return [];
}

/** Whether an actor may change or remove a member who currently has `target`. */
export function canManageMember(actor: WorkspaceRole, target: WorkspaceRole) {
  return actor === 'owner' || (actor === 'admin' && target !== 'owner');
}
