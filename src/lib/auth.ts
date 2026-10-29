import 'server-only';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { findWorkspaceBySlug, getMemberRole, type Workspace } from '@/lib/workspaces';
import { hasRole, type WorkspaceRole } from '@/lib/workspace-roles';

export type AdminAuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; error: string };

export type WorkspaceAuthResult =
  | {
      ok: true;
      user: User;
      workspace: Workspace;
      role: WorkspaceRole;
      /** True when a website admin (platform staff) opens a workspace they aren't a member of. */
      viaPlatform: boolean;
    }
  | { ok: false; status: 401 | 403 | 404; error: string };

/** True if the user has any role (admin or user) on this website. */
export async function hasWebsiteAccess(userId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc('has_website_access', {
    p_website_id: WEBSITE_ID,
    p_user_id: userId,
  });
  if (error) throw new Error(`Website access check failed: ${error.message}`);
  return data === true;
}

export async function isWebsiteAdmin(userId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc('is_admin', {
    p_website_id: WEBSITE_ID,
    p_user_id: userId,
  });
  if (error) throw new Error(`Admin check failed: ${error.message}`);
  return data === true;
}

async function sessionUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Verifies the session user is a website admin (platform staff). Use in every /api/platform handler. */
export async function authorizeAdmin(): Promise<AdminAuthResult> {
  const user = await sessionUser();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
  if (!(await isWebsiteAdmin(user.id))) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true, user };
}

/** For platform pages (inside Suspense, after connection()): redirects non-admins. */
export async function requireAdminPage(next: string): Promise<User> {
  const auth = await authorizeAdmin();
  if (auth.ok) return auth.user;
  redirect(auth.status === 401 ? `/login?next=${encodeURIComponent(next)}` : '/dashboard');
}

/** Any signed-in member of this website (admin or user). */
export async function authorizeMember(): Promise<AdminAuthResult> {
  const user = await sessionUser();
  if (!user) return { ok: false, status: 401, error: 'Log in to continue' };
  if (!(await hasWebsiteAccess(user.id))) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true, user };
}

/** For member pages (dashboard, onboarding): redirects signed-out visitors to log in. */
export async function requireMemberPage(next: string): Promise<User> {
  const auth = await authorizeMember();
  if (auth.ok) return auth.user;
  redirect(`/login?next=${encodeURIComponent(next)}`);
}

// A workspace layout and its page both check access; React's cache dedupes it within one render
const resolveWorkspaceAccess = cache(async (slug: string): Promise<WorkspaceAuthResult> => {
  const user = await sessionUser();
  if (!user) return { ok: false, status: 401, error: 'Log in to continue' };

  const workspace = await findWorkspaceBySlug(slug);
  if (!workspace) return { ok: false, status: 404, error: 'Workspace not found' };

  let role = await getMemberRole(workspace.id, user.id);
  let viaPlatform = false;
  if (!role && (await isWebsiteAdmin(user.id))) {
    role = 'owner';
    viaPlatform = true;
  }
  if (!role) return { ok: false, status: 404, error: 'Workspace not found' };
  return { ok: true, user, workspace, role, viaPlatform };
});

/**
 * Resolves a workspace by slug and checks the session user's role in it.
 * Website admins get owner access to every workspace (support and the platform console).
 * Unknown workspaces and non-members both get 404, so slugs can't be probed.
 */
export async function authorizeWorkspace(slug: string, minimum: WorkspaceRole): Promise<WorkspaceAuthResult> {
  const access = await resolveWorkspaceAccess(slug);
  if (!access.ok) return access;
  const { user, workspace, role, viaPlatform } = access;
  if (!hasRole(role, minimum)) {
    return { ok: false, status: 403, error: 'Your role in this workspace doesn’t allow this' };
  }
  return { ok: true, user, workspace, role, viaPlatform };
}

/** For workspace pages: redirects to login, 404s for non-members, sends members to the Test page. */
export async function requireWorkspacePage(
  slug: string,
  minimum: WorkspaceRole,
  path = ''
): Promise<Extract<WorkspaceAuthResult, { ok: true }>> {
  const auth = await authorizeWorkspace(slug, minimum);
  if (auth.ok) return auth;
  if (auth.status === 401) redirect(`/login?next=${encodeURIComponent(`/w/${slug}${path}`)}`);
  if (auth.status === 403) redirect(`/w/${slug}/test`);
  notFound();
}
