import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { MAX_CALL_DURATION_MS } from '@/lib/constants';
import {
  END_CALL_TOOL,
  ensureAgentWebhook,
  findAgentConfig,
  getOrProvisionAgentConfig,
  normalizeConfig,
  retellAgentName,
  type AgentConfig,
} from '@/lib/agent-config';
import {
  buildPrompt,
  findUnsafeInstructions,
  MAX_PROMPT_CHARS,
  MAX_RULES,
  normalizeProfile,
  profileBody,
  type BusinessProfile,
  type PromptMode,
} from '@/lib/prompt';
import { isTemplateId } from '@/lib/templates';
import { ANALYSIS_FIELDS } from '@/lib/call-analysis';
import { enabledModules, MANAGED_TOOL_NAMES, moduleTools, modulesPrompt } from '@/lib/modules-agent';
import type { Workspace } from '@/lib/workspaces';

// How Retell versions work (verified against the API):
// - Publishing agent version N also publishes its LLM version; published versions are read-only.
// - agent.createVersion({ base_version: N }) makes a draft N+1 (agent + LLM copy).
// - agent.update / llm.update without a version edit the newest version (the draft).
// - A call without agent_version uses the newest version, drafts included, so every live
//   call is pinned to va_agent_configs.live_version.
// - The knowledge base isn't versioned: FAQs, pages and files apply to every version at once.

export type Rule = { id: string; rule: string; origin: 'manual' | 'correction'; created_at: string };

export type Change = {
  id: string;
  action: 'edit' | 'publish' | 'rollback';
  scope: 'draft' | 'live';
  version: number | null;
  summary: string;
  changed_by: string | null;
  changed_by_email: string | null;
  created_at: string;
  can_restore: boolean;
};

/** Prompt-side settings saved with every publish, restored on rollback. */
type Snapshot = Pick<
  AgentConfig,
  'agent_name' | 'voice_id' | 'voice_speed' | 'begin_message' | 'general_prompt' | 'prompt_mode' | 'custom_prompt'
> & { profile: unknown; rules: string[] };

export class DraftError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function db() {
  return createAdminClient();
}

function industry(workspace: Workspace) {
  return isTemplateId(workspace.template) ? workspace.template : 'support';
}

export function configProfile(workspace: Workspace, config: AgentConfig): BusinessProfile {
  return normalizeProfile(config.profile, workspace.name, industry(workspace));
}

/** Publishes a version. The API answers 200 with an empty body, which the SDK can't parse. */
async function publishVersion(agentId: string, version: number, title: string) {
  const res = await getRetell().agent.publish(agentId, { version, version_title: title.slice(0, 80) }).asResponse();
  if (!res.ok) throw new Error(`Retell publish failed (${res.status})`);
}

/**
 * First use of the studio: publish what callers hear today as the live version, so draft
 * edits stop reaching calls. Safe to call on every load; it only acts once.
 */
async function initVersioning(config: AgentConfig): Promise<AgentConfig> {
  if (config.live_version !== null) return config;
  const agent = await getRetell().agent.retrieve(config.retell_agent_id);
  if (!agent.is_published) await publishVersion(config.retell_agent_id, agent.version, 'Initial version');

  const { data, error } = await db()
    .from('va_agent_configs')
    .update({ live_version: agent.version, published_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', config.workspace_id)
    .is('live_version', null)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Failed to start versioning: ${error.message}`);
  return data ? normalizeConfig(data as AgentConfig) : ((await findAgentConfig(config.workspace_id)) ?? config);
}

/** Makes sure the newest Retell version is an editable draft. Returns its version number. */
async function ensureDraftVersion(config: AgentConfig): Promise<number> {
  const retell = getRetell();
  const latest = await retell.agent.retrieve(config.retell_agent_id);
  if (!latest.is_published) return latest.version;
  await retell.agent.createVersion(config.retell_agent_id, { base_version: latest.version });
  return (await retell.agent.retrieve(config.retell_agent_id)).version;
}

/**
 * The workspace's config with versioning started and a draft ready to edit.
 * Provisions the Retell agent on first use.
 */
export async function prepareDraft(workspace: Workspace): Promise<AgentConfig> {
  let config = await getOrProvisionAgentConfig(workspace);
  config = await initVersioning(config);
  await ensureDraftVersion(config);
  // Webhook settings live on the draft too, so they ship with the next publish
  await ensureAgentWebhook(config).catch((err) => console.error('[agent-draft] webhook setup failed', err));
  return config;
}

/** The draft LLM's tools with end_call added if it's missing (older agents were created without it). */
async function toolsWithEndCall(llmId: string) {
  const tools = (await getRetell().llm.retrieve(llmId)).general_tools ?? [];
  return tools.some((t) => t.type === 'end_call') ? null : [...tools, END_CALL_TOOL];
}

/**
 * Adds end_call to the draft if it's missing, logged as a draft edit. Test simulations need
 * it: without a way to hang up, Retell stops the conversation as a loop.
 */
export async function ensureEndCallTool(workspace: Workspace, config: AgentConfig): Promise<void> {
  const tools = await toolsWithEndCall(config.retell_llm_id);
  if (!tools) return;
  await getRetell().llm.update(config.retell_llm_id, { general_tools: tools });
  await db()
    .from('va_agent_configs')
    .update({ draft_changed_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id);
  await logChange(workspace, { action: 'edit', scope: 'draft', summary: 'Let the agent end the call after a goodbye', userId: null });
}

export async function listRules(workspaceId: string): Promise<Rule[]> {
  const { data, error } = await db()
    .from('va_agent_rules')
    .select('id, rule, origin, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load rules: ${error.message}`);
  return data as Rule[];
}

export async function logChange(
  workspace: Workspace,
  entry: { action: Change['action']; scope: Change['scope']; summary: string; userId: string | null; version?: number; snapshot?: Snapshot }
) {
  const { error } = await db().from('va_agent_changes').insert({
    website_id: WEBSITE_ID,
    workspace_id: workspace.id,
    action: entry.action,
    scope: entry.scope,
    version: entry.version ?? null,
    summary: entry.summary.slice(0, 500),
    snapshot: entry.snapshot ?? null,
    changed_by: entry.userId,
  });
  if (error) console.error('[agent-draft] failed to log change', error.message);
}

export type DraftPatch = Partial<
  Pick<AgentConfig, 'agent_name' | 'voice_id' | 'voice_speed' | 'begin_message' | 'prompt_mode' | 'custom_prompt'> & {
    profile: BusinessProfile;
  }
>;

/**
 * Applies changes to the draft: rebuilds the prompt (platform rules + profile or Advanced
 * prompt + team rules), pushes it to the draft Retell version and saves the row.
 */
export async function saveDraft(workspace: Workspace, userId: string, patch: DraftPatch, summary: string): Promise<AgentConfig> {
  const config = await prepareDraft(workspace);
  const next = { ...config, ...patch };
  const mode: PromptMode = next.prompt_mode;
  const profile = patch.profile ?? configProfile(workspace, config);
  const rules = (await listRules(workspace.id)).map((r) => r.rule);

  const body = mode === 'advanced' ? (next.custom_prompt ?? '') : profileBody(profile, next.agent_name);
  if (mode === 'advanced' && !body.trim()) throw new DraftError('The Advanced prompt can’t be empty', 400);
  if (body.length > MAX_PROMPT_CHARS) {
    throw new DraftError(`The prompt is too long (${body.length} of ${MAX_PROMPT_CHARS} characters)`, 400);
  }
  const modules = await enabledModules(workspace.id);
  const prompt = buildPrompt({
    mode,
    profile,
    customPrompt: next.custom_prompt,
    rules,
    agentName: next.agent_name,
    extra: modulesPrompt(modules),
  });

  const retell = getRetell();
  await retell.agent.update(config.retell_agent_id, {
    agent_name: retellAgentName(workspace, next.agent_name),
    voice_id: next.voice_id,
    voice_speed: next.voice_speed,
    max_call_duration_ms: MAX_CALL_DURATION_MS,
    // Inbound phone calls can't take overrides, so the version itself carries the analysis
    post_call_analysis_data: ANALYSIS_FIELDS,
  });
  // Tools we manage (end_call, module functions) are rebuilt; anything else on the LLM is kept
  const existing = (await retell.llm.retrieve(config.retell_llm_id)).general_tools ?? [];
  await retell.llm.update(config.retell_llm_id, {
    general_prompt: prompt,
    begin_message: next.begin_message,
    general_tools: [...existing.filter((t) => !MANAGED_TOOL_NAMES.has(t.name)), END_CALL_TOOL, ...moduleTools(modules)],
  });

  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('va_agent_configs')
    .update({
      ...patch,
      ...(patch.profile && { profile: patch.profile }),
      general_prompt: prompt,
      draft_changed_at: now,
      updated_at: now,
    })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .select('*')
    .single();
  if (error) throw new Error(`Saved to Retell but failed to update Supabase: ${error.message}`);
  await logChange(workspace, { action: 'edit', scope: 'draft', summary, userId });
  return normalizeConfig(data as AgentConfig);
}

export async function addRule(workspace: Workspace, userId: string, rule: string, origin: Rule['origin'] = 'manual') {
  const text = rule.trim();
  if (!text || text.length > 500) throw new DraftError('A rule is 1–500 characters', 400);
  const existing = await listRules(workspace.id);
  if (existing.length >= MAX_RULES) throw new DraftError(`Up to ${MAX_RULES} rules`, 400);
  const { error } = await db()
    .from('va_agent_rules')
    .insert({ website_id: WEBSITE_ID, workspace_id: workspace.id, rule: text, origin, created_by: userId });
  if (error) throw new Error(`Failed to add rule: ${error.message}`);
  await saveDraft(workspace, userId, {}, `Added rule: “${text.slice(0, 120)}”`);
}

export async function deleteRule(workspace: Workspace, userId: string, ruleId: string) {
  const { data, error } = await db()
    .from('va_agent_rules')
    .delete()
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', ruleId)
    .select('rule')
    .maybeSingle();
  if (error) throw new Error(`Failed to delete rule: ${error.message}`);
  if (!data) throw new DraftError('Rule not found', 404);
  await saveDraft(workspace, userId, {}, `Removed rule: “${data.rule.slice(0, 120)}”`);
}

export type DraftStatus = {
  liveVersion: number | null;
  publishedAt: string | null;
  /** Prompt/voice edits waiting for Publish, newest first. */
  pendingEdits: { summary: string; created_at: string }[];
};

export async function getDraftStatus(workspace: Workspace, config: AgentConfig): Promise<DraftStatus> {
  let query = db()
    .from('va_agent_changes')
    .select('summary, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('action', 'edit')
    .eq('scope', 'draft')
    .order('created_at', { ascending: false })
    .limit(20);
  if (config.published_at) query = query.gt('created_at', config.published_at);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load draft changes: ${error.message}`);
  return { liveVersion: config.live_version, publishedAt: config.published_at, pendingEdits: data ?? [] };
}

/** Problems in the parts of the prompt a workspace controls. Empty when it may be published. */
export async function safetyProblems(workspace: Workspace, config: AgentConfig): Promise<string[]> {
  const rules = (await listRules(workspace.id)).map((r) => r.rule);
  const body =
    config.prompt_mode === 'advanced'
      ? (config.custom_prompt ?? '')
      : profileBody(configProfile(workspace, config), config.agent_name);
  return findUnsafeInstructions([body, config.begin_message, ...rules].join('\n'));
}

async function snapshotOf(workspace: Workspace, config: AgentConfig): Promise<Snapshot> {
  return {
    agent_name: config.agent_name,
    voice_id: config.voice_id,
    voice_speed: config.voice_speed,
    begin_message: config.begin_message,
    general_prompt: config.general_prompt,
    prompt_mode: config.prompt_mode,
    custom_prompt: config.custom_prompt,
    profile: config.profile,
    rules: (await listRules(workspace.id)).map((r) => r.rule),
  };
}

/** Publishes the draft: callers hear it from their next call. Starts a fresh draft from it. */
export async function publishDraft(workspace: Workspace, userId: string, note: string): Promise<AgentConfig> {
  const config = await prepareDraft(workspace);
  const problems = await safetyProblems(workspace, config);
  if (problems.length) throw new DraftError(`Can’t publish: ${problems.join(' ')}`, 422);

  const draftVersion = await ensureDraftVersion(config);
  const title = note.trim() || 'Published from the studio';
  await publishVersion(config.retell_agent_id, draftVersion, title);
  // Keep a draft open so the next edit doesn't hit a read-only version
  await getRetell().agent.createVersion(config.retell_agent_id, { base_version: draftVersion });

  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('va_agent_configs')
    .update({ live_version: draftVersion, published_at: now, draft_changed_at: null })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .select('*')
    .single();
  if (error) throw new Error(`Published in Retell but failed to save: ${error.message}`);
  await logChange(workspace, {
    action: 'publish',
    scope: 'live',
    version: draftVersion,
    summary: title,
    userId,
    snapshot: await snapshotOf(workspace, config),
  });
  return normalizeConfig(data as AgentConfig);
}

/**
 * Makes an earlier published version live again: a new version is created from it and
 * published, and the studio settings are restored from that publish. Unpublished draft
 * edits are discarded. Knowledge (FAQs, pages, files) isn't versioned and stays as is.
 */
export async function rollbackTo(workspace: Workspace, userId: string, changeId: string): Promise<AgentConfig> {
  const { data: change, error: loadErr } = await db()
    .from('va_agent_changes')
    .select('version, snapshot, summary, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', changeId)
    .in('action', ['publish', 'rollback'])
    .maybeSingle();
  if (loadErr) throw new Error(`Failed to load version: ${loadErr.message}`);
  if (!change?.snapshot || change.version === null) throw new DraftError('That version can’t be restored', 404);

  const config = await prepareDraft(workspace);
  const retell = getRetell();
  await retell.agent.createVersion(config.retell_agent_id, { base_version: change.version });
  const restored = (await retell.agent.retrieve(config.retell_agent_id)).version;
  await publishVersion(config.retell_agent_id, restored, `Rollback to version ${change.version}`);
  await retell.agent.createVersion(config.retell_agent_id, { base_version: restored });

  const snap = change.snapshot as Snapshot;
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('va_agent_configs')
    .update({
      agent_name: snap.agent_name,
      voice_id: snap.voice_id,
      voice_speed: snap.voice_speed,
      begin_message: snap.begin_message,
      general_prompt: snap.general_prompt,
      prompt_mode: snap.prompt_mode,
      custom_prompt: snap.custom_prompt,
      profile: snap.profile ?? {},
      live_version: restored,
      published_at: now,
      draft_changed_at: null,
      updated_at: now,
    })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .select('*')
    .single();
  if (error) throw new Error(`Rolled back in Retell but failed to save: ${error.message}`);

  // Rules are part of the prompt, so they go back to what that version had
  await db().from('va_agent_rules').delete().eq('website_id', WEBSITE_ID).eq('workspace_id', workspace.id);
  if (snap.rules?.length) {
    await db()
      .from('va_agent_rules')
      .insert(snap.rules.map((rule) => ({ website_id: WEBSITE_ID, workspace_id: workspace.id, rule, created_by: userId })));
  }

  const when = new Date(change.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await logChange(workspace, {
    action: 'rollback',
    scope: 'live',
    version: restored,
    summary: `Rolled back to the version published ${when} (“${change.summary.slice(0, 80)}”)`,
    userId,
    snapshot: snap,
  });
  return normalizeConfig(data as AgentConfig);
}

/** History for the studio, newest first, with who made each change. */
export async function listChanges(workspace: Workspace, limit = 100): Promise<Change[]> {
  const { data, error } = await db()
    .from('va_agent_changes')
    .select('id, action, scope, version, summary, changed_by, created_at, snapshot')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load history: ${error.message}`);

  const userIds = [...new Set((data ?? []).map((c) => c.changed_by).filter(Boolean))] as string[];
  const emails = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles } = await db().from('user_profiles').select('user_id, email').in('user_id', userIds);
    for (const p of profiles ?? []) emails.set(p.user_id, p.email);
  }
  return (data ?? []).map(({ snapshot, ...c }) => ({
    ...c,
    changed_by_email: c.changed_by ? (emails.get(c.changed_by) ?? null) : null,
    can_restore: (c.action === 'publish' || c.action === 'rollback') && Boolean(snapshot) && c.version !== null,
  })) as Change[];
}

/** Publishes made from the studio (the automatic first version doesn't count). */
export async function countPublishes(workspaceId: string): Promise<number> {
  const { count, error } = await db()
    .from('va_agent_changes')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .in('action', ['publish', 'rollback']);
  if (error) throw new Error(`Failed to count publishes: ${error.message}`);
  return count ?? 0;
}
