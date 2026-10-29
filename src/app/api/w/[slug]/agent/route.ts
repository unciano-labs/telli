import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import type { VoiceSettings } from '@/lib/agent-config';
import { DraftError, prepareDraft, saveDraft } from '@/lib/agent-draft';
import { MAX_VOICE_SPEED, MIN_VOICE_SPEED } from '@/lib/constants';

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ config: await prepareDraft(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/agent GET', [DraftError]);
  }
}

function parseSettings(body: unknown): VoiceSettings | string {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const settings: VoiceSettings = {
    agent_name: str(b.agent_name),
    voice_id: str(b.voice_id),
    voice_speed: Number(b.voice_speed),
    begin_message: str(b.begin_message),
  };
  if (!settings.agent_name || settings.agent_name.length > 100) return 'Agent name is required (max 100 characters)';
  if (!settings.voice_id) return 'Voice is required';
  if (!(settings.voice_speed >= MIN_VOICE_SPEED && settings.voice_speed <= MAX_VOICE_SPEED)) {
    return `Voice speed must be between ${MIN_VOICE_SPEED} and ${MAX_VOICE_SPEED}`;
  }
  if (!settings.begin_message || settings.begin_message.length > 500) return 'Opening greeting is required (max 500 characters)';
  return settings;
}

/** Body: { agent_name, voice_id, voice_speed, begin_message }. Saves to the draft. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const parsed = parseSettings(await req.json().catch(() => null));
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    const config = await saveDraft(auth.workspace, auth.user.id, parsed, 'Updated the voice and greeting');
    return NextResponse.json({ config });
  } catch (error) {
    return errorResponse(error, 'w/agent PATCH', [DraftError]);
  }
}
