import 'server-only';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { findAgentConfig } from '@/lib/agent-config';
import { insertCallLog, type CallSource } from '@/lib/call-logs';
import type { Workspace } from '@/lib/workspaces';
import { callLimitMs } from '@/lib/billing';
import { MAX_CALL_DURATION_MS, RETELL_MIN_CALL_MS } from '@/lib/constants';
import { ANALYSIS_FIELDS } from '@/lib/call-analysis';
import type { CallCreateWebCallParams } from 'retell-sdk/resources/call';

export type AgentLanguage = NonNullable<NonNullable<CallCreateWebCallParams.AgentOverride['agent']>['language']>;

export type WebCallToken = {
  access_token: string;
  call_id: string;
  transport: string;
  ice_servers: unknown;
};

export class AgentNotConfiguredError extends Error {}

/**
 * Creates a browser call on a workspace's agent and logs it under that workspace.
 * Suspended or unpaid workspaces and used-up minutes throw CallBlockedError; calls are capped
 * to the time left. Logging failures don't block the caller: the webhook can't backfill
 * them, so they're reported loudly.
 */
export async function startWebCall(input: {
  workspace: Workspace;
  source: Extract<CallSource, 'landing' | 'widget' | 'demo' | 'test'>;
  widgetId?: string | null;
  pageUrl?: string | null;
  visitorId?: string | null;
  userId?: string | null;
  /** Defaults to the workspace's agent. */
  agentId?: string;
  /** With agentId: the version to pin (e.g. another workspace’s published version, in the demo). */
  agentVersion?: number;
  /**
   * Ends the call sooner than the agent's 5-minute cap (demo allowances). Retell's floor is
   * 1 minute, so shorter allowances must also be ended by the client.
   */
  maxDurationMs?: number;
  dynamicVariables?: Record<string, string>;
  /** Overrides the agent's speech recognition language(s) for this call. */
  language?: AgentLanguage;
  /**
   * Which version of the workspace agent answers: the published one (default) or the
   * draft being edited in the studio (test calls). Ignored when agentId is given.
   */
  version?: 'live' | 'draft';
}): Promise<WebCallToken> {
  const { workspace } = input;
  const trialLimitMs = await callLimitMs(workspace);

  let agentId = input.agentId;
  // Unpinned calls get the newest version, which may be an unpublished draft
  let agentVersion: number | undefined = input.agentVersion;
  // The workspace agent's calls feed the studio's Improve tab, whichever version answers
  const analyze = !agentId;
  if (!agentId) {
    const config = await findAgentConfig(workspace.id);
    if (!config) throw new AgentNotConfiguredError('The voice agent is not configured yet');
    agentId = config.retell_agent_id;
    if (input.version !== 'draft') agentVersion = config.live_version ?? undefined;
  }

  // Minutes left this month can be hours; no call runs past the 5-minute cap (Retell allows 1 minute to 2 hours)
  const caps = [input.maxDurationMs, trialLimitMs].filter((ms): ms is number => ms !== undefined);
  const maxDurationMs = caps.length ? Math.max(Math.min(...caps, MAX_CALL_DURATION_MS), RETELL_MIN_CALL_MS) : undefined;

  const call = await getRetell().call.createWebCall({
    agent_id: agentId,
    ...(agentVersion !== undefined && { agent_version: agentVersion }),
    metadata: {
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      source: input.source,
      widget_id: input.widgetId ?? null,
    },
    ...((maxDurationMs || input.language || analyze) && {
      agent_override: {
        agent: {
          ...(maxDurationMs && { max_call_duration_ms: maxDurationMs }),
          ...(input.language && { language: input.language }),
          ...(analyze && { post_call_analysis_data: ANALYSIS_FIELDS }),
        },
      },
    }),
    ...(input.dynamicVariables && { retell_llm_dynamic_variables: input.dynamicVariables }),
  });

  try {
    await insertCallLog({
      workspace_id: workspace.id,
      retell_call_id: call.call_id,
      direction: 'web',
      source: input.source,
      status: 'registered',
      widget_id: input.widgetId ?? null,
      page_url: input.pageUrl ?? null,
      visitor_id: input.visitorId ?? null,
      user_id: input.userId ?? null,
    });
  } catch (error) {
    console.error('[web-calls] call created but not logged', call.call_id, error);
  }

  return {
    access_token: call.access_token,
    call_id: call.call_id,
    transport: call.transport,
    ice_servers: call.ice_servers,
  };
}
