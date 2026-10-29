import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { DraftError, saveDraft } from '@/lib/agent-draft';
import { MAX_FIELD_CHARS, MAX_PROMPT_CHARS, normalizeProfile, PROFILE_FIELDS, type PromptMode } from '@/lib/prompt';
import { isTemplateId } from '@/lib/templates';

/** Body: { prompt_mode: "profile" | "advanced", profile, custom_prompt }. Saves to the draft. */
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const mode = body?.prompt_mode as PromptMode;
  if (mode !== 'profile' && mode !== 'advanced') {
    return NextResponse.json({ error: 'prompt_mode must be "profile" or "advanced"' }, { status: 400 });
  }
  const raw = body?.profile && typeof body.profile === 'object' ? body.profile : {};
  if (!isTemplateId(raw.industry)) return NextResponse.json({ error: 'Choose what your agent does' }, { status: 400 });
  const profile = normalizeProfile(raw, auth.workspace.name, raw.industry);
  if (!profile.businessName.trim() || profile.businessName.length > 80) {
    return NextResponse.json({ error: 'Business name is required (max 80 characters)' }, { status: 400 });
  }
  const tooLong = PROFILE_FIELDS.find((f) => profile[f].length > MAX_FIELD_CHARS);
  if (tooLong) {
    return NextResponse.json({ error: `“${tooLong}” is too long (max ${MAX_FIELD_CHARS} characters)` }, { status: 400 });
  }
  const customPrompt = typeof body?.custom_prompt === 'string' ? body.custom_prompt.trim() : '';
  if (customPrompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json({ error: `The Advanced prompt is too long (max ${MAX_PROMPT_CHARS} characters)` }, { status: 400 });
  }

  try {
    const config = await saveDraft(
      auth.workspace,
      auth.user.id,
      { prompt_mode: mode, profile, custom_prompt: customPrompt || null },
      mode === 'advanced' ? 'Edited the Advanced prompt' : 'Updated the business profile'
    );
    return NextResponse.json({ config });
  } catch (error) {
    return errorResponse(error, 'w/profile PATCH', [DraftError]);
  }
}
