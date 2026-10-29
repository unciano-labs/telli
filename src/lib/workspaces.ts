import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { isTemplateId, type TemplateId } from '@/lib/templates';
import type { WorkspaceRole, WorkspaceStatus } from '@/lib/workspace-roles';

export type Workspace = {
  id: string;
  website_id: string;
  name: string;
  slug: string;
  template: TemplateId | null;
  plan: string;
  status: WorkspaceStatus;
  trial_seconds: number;
  /** End of the last paid month (lib/billing). */
  current_period_end: string | null;
  is_platform: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkspaceSummary = Pick<Workspace, 'id' | 'name' | 'slug' | 'status' | 'is_platform'> & {
  role: WorkspaceRole;
};

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** Workspaces a user may own (the platform workspace doesn't count). */
export const MAX_OWNED_WORKSPACES = 3;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function db() {
  return createAdminClient();
}

export function isSlug(value: string) {
  return SLUG_PATTERN.test(value);
}

export async function findWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  if (!isSlug(slug)) return null;
  const { data, error } = await db()
    .from('va_workspaces')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`Failed to load workspace: ${error.message}`);
  return (data as Workspace) ?? null;
}

export async function findWorkspaceById(id: string): Promise<Workspace | null> {
  const { data, error } = await db()
    .from('va_workspaces')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load workspace: ${error.message}`);
  return (data as Workspace) ?? null;
}

/** The workspace that runs this site's own agent (landing dialer, demo "Our support agent"). */
export async function getPlatformWorkspace(): Promise<Workspace> {
  const { data, error } = await db()
    .from('va_workspaces')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('is_platform', true)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the platform workspace: ${error.message}`);
  if (!data) throw new Error('The platform workspace is missing. Run the workspaces migration.');
  return data as Workspace;
}

/** The user's role in a workspace, or null if they aren't a member. */
export async function getMemberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const { data, error } = await db()
    .from('va_workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load membership: ${error.message}`);
  return (data?.role as WorkspaceRole) ?? null;
}

export async function listUserWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const { data, error } = await db()
    .from('va_workspace_members')
    .select('role, va_workspaces!inner(id, name, slug, status, is_platform, website_id)')
    .eq('user_id', userId)
    .eq('va_workspaces.website_id', WEBSITE_ID)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load workspaces: ${error.message}`);
  return (data as unknown as { role: WorkspaceRole; va_workspaces: Workspace }[]).map(({ role, va_workspaces: w }) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    status: w.status,
    is_platform: w.is_platform,
    role,
  }));
}

function slugify(name: string) {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return base.length >= 3 ? base : `ws-${base || 'new'}`.slice(0, 32);
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

/** Creates the workspace and makes the user its owner. Retell resources are provisioned separately. */
export async function createWorkspace(input: { userId: string; name: string; template: string }): Promise<Workspace> {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new WorkspaceError('Business name is required (max 80 characters)', 400);
  if (!isTemplateId(input.template)) throw new WorkspaceError('Choose a template', 400);

  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 32)}-${randomSuffix()}`;
    const { data, error } = await db()
      .rpc('va_create_workspace', {
        p_website_id: WEBSITE_ID,
        p_user_id: input.userId,
        p_name: name,
        p_slug: slug,
        p_template: input.template,
        p_max_owned: MAX_OWNED_WORKSPACES,
      })
      .single();
    // 23505: another request took the slug between the check and the insert
    if (error?.code === '23505') continue;
    if (error) throw new Error(`Failed to create workspace: ${error.message}`);

    const result = data as { workspace_id: string | null; error: string | null };
    if (result.error === 'slug_taken') continue;
    if (result.error === 'limit') {
      throw new WorkspaceError(`You can own up to ${MAX_OWNED_WORKSPACES} workspaces.`, 403);
    }
    const workspace = await findWorkspaceById(result.workspace_id!);
    if (!workspace) throw new Error('Workspace was not saved');
    return workspace;
  }
  throw new WorkspaceError('Could not find a free web address for this name. Try a different name.', 409);
}

/** Talk time used, for trial limits. */
export async function getWorkspaceUsageSeconds(workspaceId: string): Promise<number> {
  const { data, error } = await db().rpc('va_workspace_usage', {
    p_website_id: WEBSITE_ID,
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(`Failed to load usage: ${error.message}`);
  return Number(data ?? 0);
}

export type PlatformWorkspaceRow = Pick<
  Workspace,
  'id' | 'name' | 'slug' | 'status' | 'plan' | 'is_platform' | 'trial_seconds' | 'current_period_end' | 'created_at'
> & {
  owner_email: string | null;
  members: number;
  widgets: number;
  documents: number;
  calls: number;
  seconds: number;
  cost_cents: number;
  total_seconds: number;
};

/** Every workspace with its owner and usage over the last `days` days (platform console). */
export async function listPlatformWorkspaces(days: number): Promise<PlatformWorkspaceRow[]> {
  const { data, error } = await db().rpc('va_platform_workspaces', {
    p_website_id: WEBSITE_ID,
    p_since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw new Error(`Failed to load workspaces: ${error.message}`);
  const { data: periods, error: periodErr } = await db()
    .from('va_workspaces')
    .select('id, current_period_end')
    .eq('website_id', WEBSITE_ID);
  if (periodErr) throw new Error(`Failed to load workspaces: ${periodErr.message}`);
  const paidThrough = new Map((periods ?? []).map((p) => [p.id, p.current_period_end as string | null]));
  return (data as PlatformWorkspaceRow[]).map((r) => ({
    ...r,
    current_period_end: paidThrough.get(r.id) ?? null,
    members: Number(r.members),
    widgets: Number(r.widgets),
    documents: Number(r.documents),
    calls: Number(r.calls),
    seconds: Number(r.seconds),
    cost_cents: Number(r.cost_cents),
    total_seconds: Number(r.total_seconds),
  }));
}

/** Platform console: change a workspace's status or trial minutes. */
export async function updateWorkspaceAdmin(
  id: string,
  update: { status?: WorkspaceStatus; trial_seconds?: number }
): Promise<Workspace> {
  const workspace = await findWorkspaceById(id);
  if (!workspace) throw new WorkspaceError('Workspace not found', 404);
  if (workspace.is_platform && update.status && update.status !== 'active') {
    throw new WorkspaceError('The platform workspace always stays active', 400);
  }
  const { data, error } = await db()
    .from('va_workspaces')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to update workspace: ${error.message}`);
  return data as Workspace;
}
