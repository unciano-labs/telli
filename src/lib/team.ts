import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import type { Workspace } from '@/lib/workspaces';
import { assignableRoles, canManageMember, type WorkspaceRole } from '@/lib/workspace-roles';

export type Member = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: WorkspaceRole;
  joined_at: string;
};

export type Invite = {
  id: string;
  email: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  created_at: string;
  expires_at: string;
};

export type Actor = { userId: string; role: WorkspaceRole };

export class TeamError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_OPEN_INVITES = 25;

function db() {
  return createAdminClient();
}

/** Invite links carry a random token; only its hash is stored. */
export function hashInviteToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function listMembers(workspace: Workspace): Promise<Member[]> {
  const { data, error } = await db().rpc('va_workspace_member_list', {
    p_website_id: WEBSITE_ID,
    p_workspace_id: workspace.id,
  });
  if (error) throw new Error(`Failed to load members: ${error.message}`);
  return data as Member[];
}

/** Open invites (not yet accepted), including expired ones so they can be revoked. */
export async function listInvites(workspace: Workspace): Promise<Invite[]> {
  const { data, error } = await db()
    .from('va_workspace_invites')
    .select('id, email, role, created_at, expires_at')
    .eq('workspace_id', workspace.id)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load invites: ${error.message}`);
  return data as Invite[];
}

/**
 * Creates (or replaces) an invite for an email. Returns the one-time link token:
 * it's shown to the inviter once and can't be recovered later.
 */
export async function createInvite(
  workspace: Workspace,
  actor: Actor,
  input: { email: string; role: WorkspaceRole }
): Promise<{ invite: Invite; token: string }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new TeamError('Enter a valid email address', 400);
  if (input.role === 'owner' || !assignableRoles(actor.role).includes(input.role)) {
    throw new TeamError('You can invite admins and members', 403);
  }

  const members = await listMembers(workspace);
  if (members.some((m) => m.email?.toLowerCase() === email)) {
    throw new TeamError('That person is already in this workspace', 409);
  }
  const open = await listInvites(workspace);
  if (open.length >= MAX_OPEN_INVITES && !open.some((i) => i.email === email)) {
    throw new TeamError(`Up to ${MAX_OPEN_INVITES} open invites. Revoke some first.`, 400);
  }

  // A new invite replaces any open one for the same email (and its old link)
  await db().from('va_workspace_invites').delete().eq('workspace_id', workspace.id).eq('email', email).is('accepted_at', null);

  const token = randomBytes(24).toString('base64url');
  const { data, error } = await db()
    .from('va_workspace_invites')
    .insert({
      workspace_id: workspace.id,
      email,
      role: input.role,
      token_hash: hashInviteToken(token),
      invited_by: actor.userId,
    })
    .select('id, email, role, created_at, expires_at')
    .single();
  if (error) throw new Error(`Failed to create invite: ${error.message}`);
  return { invite: data as Invite, token };
}

export async function revokeInvite(workspace: Workspace, inviteId: string): Promise<void> {
  const { data, error } = await db()
    .from('va_workspace_invites')
    .delete()
    .eq('workspace_id', workspace.id)
    .eq('id', inviteId)
    .is('accepted_at', null)
    .select('id');
  if (error) throw new Error(`Failed to revoke invite: ${error.message}`);
  if (!data?.length) throw new TeamError('Invite not found', 404);
}

function assertNotLastOwner(members: Member[], target: Member) {
  if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length === 1) {
    throw new TeamError('A workspace needs at least one owner. Make someone else an owner first.', 400);
  }
}

export async function changeMemberRole(
  workspace: Workspace,
  actor: Actor,
  targetUserId: string,
  role: WorkspaceRole
): Promise<void> {
  const members = await listMembers(workspace);
  const target = members.find((m) => m.user_id === targetUserId);
  if (!target) throw new TeamError('Member not found', 404);
  if (target.role === role) return;
  if (!canManageMember(actor.role, target.role) || !assignableRoles(actor.role).includes(role)) {
    throw new TeamError('Your role can’t make this change', 403);
  }
  if (role !== 'owner') assertNotLastOwner(members, target);

  const { error } = await db()
    .from('va_workspace_members')
    .update({ role })
    .eq('workspace_id', workspace.id)
    .eq('user_id', targetUserId);
  if (error) throw new Error(`Failed to change role: ${error.message}`);
}

/** Removes a member. Anyone may leave; removing others needs a higher role. */
export async function removeMember(workspace: Workspace, actor: Actor, targetUserId: string): Promise<void> {
  const members = await listMembers(workspace);
  const target = members.find((m) => m.user_id === targetUserId);
  if (!target) throw new TeamError('Member not found', 404);
  const leaving = targetUserId === actor.userId;
  if (!leaving && !canManageMember(actor.role, target.role)) {
    throw new TeamError('Your role can’t remove this member', 403);
  }
  assertNotLastOwner(members, target);

  const { error } = await db()
    .from('va_workspace_members')
    .delete()
    .eq('workspace_id', workspace.id)
    .eq('user_id', targetUserId);
  if (error) throw new Error(`Failed to remove member: ${error.message}`);
}

const ACCEPT_ERRORS: Record<string, { status: number; message: string }> = {
  invalid: { status: 404, message: 'This invite link is invalid or was already used.' },
  expired: { status: 410, message: 'This invite has expired. Ask for a new one.' },
  email_mismatch: { status: 403, message: 'This invite is for a different email address. Log in with that email.' },
};

/** Accepts an invite for the signed-in user. Returns the workspace slug. */
export async function acceptInvite(token: string, user: { id: string; email?: string }): Promise<string> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new TeamError(ACCEPT_ERRORS.invalid.message, 404);
  const { data, error } = await db()
    .rpc('va_accept_invite', {
      p_website_id: WEBSITE_ID,
      p_token_hash: hashInviteToken(token),
      p_user_id: user.id,
      p_email: user.email ?? '',
    })
    .single();
  if (error) throw new Error(`Failed to accept invite: ${error.message}`);
  const result = data as { workspace_slug: string | null; error: string | null };
  if (result.error) {
    const known = ACCEPT_ERRORS[result.error] ?? ACCEPT_ERRORS.invalid;
    throw new TeamError(known.message, known.status);
  }
  return result.workspace_slug!;
}

/** What the invite page shows before accepting. Null when the link is unusable. */
export async function previewInvite(
  token: string
): Promise<{ workspaceName: string; email: string; role: WorkspaceRole; expired: boolean } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { data, error } = await db()
    .from('va_workspace_invites')
    .select('email, role, expires_at, accepted_at, va_workspaces!inner(name, website_id)')
    .eq('token_hash', hashInviteToken(token))
    .eq('va_workspaces.website_id', WEBSITE_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load invite: ${error.message}`);
  if (!data || data.accepted_at) return null;
  const ws = data.va_workspaces as unknown as { name: string };
  return {
    workspaceName: ws.name,
    email: data.email,
    role: data.role as WorkspaceRole,
    expired: new Date(data.expires_at) < new Date(),
  };
}
