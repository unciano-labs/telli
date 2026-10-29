import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { MAX_CALL_DURATION_MS } from '@/lib/constants';
import { getTemplate, isTemplateId } from '@/lib/templates';
import { ANALYSIS_FIELDS } from '@/lib/call-analysis';
import { publicAppUrl } from '@/lib/public-url';
import { enabledModules, moduleTools, modulesPrompt } from '@/lib/modules-agent';
import { buildPrompt, emptyProfile, type BusinessProfile, type PromptMode } from '@/lib/prompt';
import type { Workspace } from '@/lib/workspaces';

export type AgentConfig = {
  website_id: string;
  workspace_id: string;
  retell_agent_id: string;
  retell_llm_id: string;
  retell_kb_id: string | null;
  agent_name: string;
  voice_id: string;
  voice_speed: number;
  begin_message: string;
  general_prompt: string;
  retell_phone_number: string | null;
  outbound_begin_message: string;
  retell_webhook_url: string | null;
  /** Raw jsonb; read it with normalizeProfile(). */
  profile: unknown;
  prompt_mode: PromptMode;
  custom_prompt: string | null;
  /** Published agent version that live calls are pinned to (null until versioning starts). */
  live_version: number | null;
  published_at: string | null;
  draft_changed_at: string | null;
  updated_at: string;
};

export type VoiceSettings = Pick<AgentConfig, 'agent_name' | 'voice_id' | 'voice_speed' | 'begin_message'>;

const DEFAULT_VOICE = { voice_id: '11labs-Adrian', voice_speed: 1.0 };

/** Lets the agent hang up after a goodbye. Without it only the caller can end a call (and test simulations loop). */
export const END_CALL_TOOL = {
  type: 'end_call' as const,
  name: 'end_call',
  description: 'End the call after the caller says goodbye or confirms they have nothing else to ask.',
};
const WEBHOOK_EVENTS = ['call_started', 'call_ended', 'call_analyzed'] as const;

export function normalizeConfig(row: AgentConfig): AgentConfig {
  // numeric columns come back from PostgREST as strings
  return { ...row, voice_speed: Number(row.voice_speed) };
}

/** Retell resource names carry the workspace slug so they're easy to find in the Retell dashboard. */
export function retellAgentName(workspace: Pick<Workspace, 'slug'>, agentName: string) {
  return `${workspace.slug} · ${agentName}`;
}

/** Reads a workspace's config row, or null if its agent hasn't been set up yet. */
export async function findAgentConfig(workspaceId: string): Promise<AgentConfig | null> {
  const { data, error } = await createAdminClient()
    .from('va_agent_configs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load agent config: ${error.message}`);
  return data ? normalizeConfig(data as AgentConfig) : null;
}

/** Finds the config that owns a Retell agent (webhooks, inbound calls). */
export async function findAgentConfigByAgentId(agentId: string): Promise<AgentConfig | null> {
  const { data, error } = await createAdminClient()
    .from('va_agent_configs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('retell_agent_id', agentId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load agent config: ${error.message}`);
  return data ? normalizeConfig(data as AgentConfig) : null;
}

type NewConfigRow = Pick<
  AgentConfig,
  | 'retell_agent_id'
  | 'retell_llm_id'
  | 'retell_kb_id'
  | 'agent_name'
  | 'voice_id'
  | 'voice_speed'
  | 'begin_message'
  | 'general_prompt'
  | 'prompt_mode'
  | 'custom_prompt'
> & { profile: BusinessProfile | Record<string, never> };

/** Adopts the agent in RETELL_AGENT_ID (platform workspace only) and imports its settings. */
async function adoptEnvAgent(agentId: string): Promise<NewConfigRow> {
  const retell = getRetell();
  const agent = await retell.agent.retrieve(agentId);
  const engine = agent.response_engine;
  if (engine.type !== 'retell-llm') {
    throw new Error(`Retell agent ${agentId} uses a "${engine.type}" response engine; this app needs a Retell LLM agent`);
  }
  const llm = await retell.llm.retrieve(engine.llm_id);
  await retell.agent.update(agentId, { max_call_duration_ms: MAX_CALL_DURATION_MS });
  const prompt = llm.general_prompt || getTemplate('support').job('our company');
  return {
    retell_agent_id: agentId,
    retell_llm_id: engine.llm_id,
    retell_kb_id: llm.knowledge_base_ids?.[0] ?? null,
    agent_name: agent.agent_name || 'Customer Support',
    voice_id: agent.voice_id || DEFAULT_VOICE.voice_id,
    voice_speed: agent.voice_speed ?? DEFAULT_VOICE.voice_speed,
    begin_message: llm.begin_message || getTemplate('support').greeting('us'),
    // An adopted agent keeps its own prompt (Advanced mode)
    general_prompt: prompt,
    prompt_mode: 'advanced',
    custom_prompt: prompt,
    profile: {},
  };
}

/** Creates a Retell LLM + agent from the workspace's template. */
async function createRetellAgent(workspace: Workspace): Promise<NewConfigRow> {
  const retell = getRetell();
  const template = getTemplate(workspace.template);
  const profile = emptyProfile(workspace.name, isTemplateId(workspace.template) ? workspace.template : 'support');
  const agentName = template.agentName(workspace.name).slice(0, 100);
  // Modules chosen at onboarding are saved before the agent is created
  const modules = await enabledModules(workspace.id);
  const settings = {
    agent_name: agentName,
    begin_message: template.greeting(workspace.name),
    general_prompt: buildPrompt({ mode: 'profile', profile, customPrompt: null, rules: [], agentName, extra: modulesPrompt(modules) }),
    ...DEFAULT_VOICE,
  };
  const llm = await retell.llm.create({
    begin_message: settings.begin_message,
    general_prompt: settings.general_prompt,
    start_speaker: 'agent',
    general_tools: [END_CALL_TOOL, ...moduleTools(modules)],
  });
  try {
    const agent = await retell.agent.create({
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      agent_name: retellAgentName(workspace, settings.agent_name),
      voice_id: settings.voice_id,
      voice_speed: settings.voice_speed,
      max_call_duration_ms: MAX_CALL_DURATION_MS,
      post_call_analysis_data: ANALYSIS_FIELDS,
    });
    return {
      retell_agent_id: agent.agent_id,
      retell_llm_id: llm.llm_id,
      retell_kb_id: null,
      ...settings,
      prompt_mode: 'profile',
      custom_prompt: null,
      profile,
    };
  } catch (error) {
    await retell.llm.delete(llm.llm_id).catch(() => {});
    throw error;
  }
}

/**
 * Returns the workspace's config row, creating its Retell agent on first use.
 * The platform workspace adopts RETELL_AGENT_ID when set; every other workspace
 * gets a new LLM + agent built from its template.
 */
export async function getOrProvisionAgentConfig(workspace: Workspace): Promise<AgentConfig> {
  const existing = await findAgentConfig(workspace.id);
  if (existing) return existing;

  const envAgentId = workspace.is_platform ? process.env.RETELL_AGENT_ID?.trim() : undefined;
  const row = envAgentId ? await adoptEnvAgent(envAgentId) : await createRetellAgent(workspace);

  const { data: inserted, error } = await createAdminClient()
    .from('va_agent_configs')
    .upsert(
      { website_id: WEBSITE_ID, workspace_id: workspace.id, ...row },
      { onConflict: 'workspace_id', ignoreDuplicates: true }
    )
    .select('workspace_id');
  if (error) throw new Error(`Failed to save agent config: ${error.message}`);

  // A concurrent first request won: remove the agent this request created
  if (!inserted?.length && !envAgentId) {
    const retell = getRetell();
    await retell.agent.delete(row.retell_agent_id).catch(() => {});
    await retell.llm.delete(row.retell_llm_id).catch(() => {});
  }

  const saved = await findAgentConfig(workspace.id);
  if (!saved) throw new Error('Agent config was not saved');
  // Track calls from the start, even if nobody reopens the Agent page
  await ensureAgentWebhook(saved).catch((err) => console.error('[agent-config] webhook setup failed', err));
  return (await findAgentConfig(workspace.id)) ?? saved;
}

export const WEBHOOK_PATH = '/api/webhooks/retell';

/** Public webhook URL for this deployment, or null when Retell can't reach us (unset, http, localhost). */
export function publicWebhookUrl(): string | null {
  const base = publicAppUrl();
  return base && `${base}${WEBHOOK_PATH}`;
}

/**
 * Points a Retell agent's webhook at this deployment when PUBLIC_APP_URL changes.
 * Returns the new URL to persist, or null when nothing changed.
 */
export async function syncAgentWebhook(agentId: string, currentUrl: string | null): Promise<string | null> {
  const url = publicWebhookUrl();
  if (!url || url === currentUrl) return null;
  await getRetell().agent.update(agentId, { webhook_url: url, webhook_events: [...WEBHOOK_EVENTS] });
  return url;
}

/** Keeps a workspace agent's webhook current. Cheap on every admin load: Retell is only called on change. */
export async function ensureAgentWebhook(config: AgentConfig): Promise<void> {
  const url = await syncAgentWebhook(config.retell_agent_id, config.retell_webhook_url);
  if (!url) return;
  const { error } = await createAdminClient()
    .from('va_agent_configs')
    .update({ retell_webhook_url: url })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', config.workspace_id);
  if (error) throw new Error(`Webhook set in Retell but not saved: ${error.message}`);
}
