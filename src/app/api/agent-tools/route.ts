import { NextResponse } from 'next/server';
import { verify } from 'retell-sdk';
import { findAgentConfigByAgentId } from '@/lib/agent-config';
import { runAgentTool } from '@/lib/bookings';
import { errorMessage } from '@/lib/retell';
import { findWorkspaceById } from '@/lib/workspaces';

/**
 * Retell custom functions (booking modules). Retell signs each request with the API key, like
 * webhooks. The workspace comes from the calling agent, never from the arguments, so one
 * business's agent can't read or book another's calendar.
 */
export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get('x-retell-signature');
  const apiKey = (process.env.RETELL_WEBHOOK_KEY || process.env.RETELL_API_KEY)?.trim();
  if (!signature || !apiKey || !(await verify(body, apiKey, signature).catch(() => false))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { name?: string; args?: Record<string, unknown>; call?: { call_id?: string; agent_id?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const agentId = payload.call?.agent_id;
  if (!payload.name || !agentId) return NextResponse.json({ error: 'Missing function name or call' }, { status: 400 });

  try {
    const config = await findAgentConfigByAgentId(agentId);
    const workspace = config && (await findWorkspaceById(config.workspace_id));
    if (!workspace) return NextResponse.json({ error: 'Unknown agent' }, { status: 404 });
    const result = await runAgentTool(workspace, payload.name, payload.args ?? {}, payload.call?.call_id ?? null);
    return NextResponse.json({ result });
  } catch (error) {
    console.error('[agent-tools]', payload.name, errorMessage(error));
    return NextResponse.json({ result: 'The booking system had a problem. Take the caller’s details and say the team will confirm.' });
  }
}
