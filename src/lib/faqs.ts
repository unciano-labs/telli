import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { logChange } from '@/lib/agent-draft';
import { addKbSources, KbError, removeKbSource, retrieveKb } from '@/lib/knowledge-base';
import type { Workspace } from '@/lib/workspaces';
import { assertWithinLimit } from '@/lib/billing';

export type Faq = {
  id: string;
  question: string;
  alternates: string[];
  answer: string;
  retell_source_id: string | null;
  status: 'syncing' | 'ready' | 'error';
  origin: 'manual' | 'correction' | 'unanswered';
  created_at: string;
  updated_at: string;
};

export type FaqInput = { question: string; alternates: string[]; answer: string };

export const MAX_FAQS = 200;
const MAX_ALTERNATES = 5;
const SYNC_GRACE_MS = 2 * 60 * 1000;

function db() {
  return createAdminClient();
}

/** Each FAQ is one knowledge base text source; the id tag in the title links them. */
function sourceTitle(faq: Pick<Faq, 'id' | 'question'>) {
  return `${faq.question.slice(0, 90)} [faq:${faq.id.slice(0, 8)}]`;
}

function sourceText(faq: FaqInput) {
  const also = faq.alternates.length ? `\nAlso asked as: ${faq.alternates.join(' / ')}` : '';
  return `Question: ${faq.question}${also}\nAnswer: ${faq.answer}`;
}

export function validateFaq(body: Record<string, unknown>): FaqInput {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  const alternates = Array.isArray(body.alternates)
    ? [...new Set(body.alternates.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean))]
    : [];
  if (!question || question.length > 300) throw new KbError('Question is required (max 300 characters)', 400);
  if (!answer || answer.length > 2000) throw new KbError('Answer is required (max 2,000 characters)', 400);
  if (alternates.length > MAX_ALTERNATES || alternates.some((a) => a.length > 300)) {
    throw new KbError(`Up to ${MAX_ALTERNATES} other ways of asking, each under 300 characters`, 400);
  }
  return { question, answer, alternates };
}

async function findFaq(workspace: Workspace, id: string): Promise<Faq | null> {
  const { data, error } = await db()
    .from('va_agent_faqs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load FAQ: ${error.message}`);
  return (data as Faq) ?? null;
}

/** Links FAQs still "syncing" to their Retell source once the knowledge base finishes processing. */
async function reconcile(workspace: Workspace, faqs: Faq[]): Promise<Faq[]> {
  const pending = faqs.filter((f) => f.status === 'syncing');
  if (!pending.length) return faqs;
  const kb = await retrieveKb(workspace);
  if (!kb || kb.status === 'in_progress' || kb.status === 'refreshing_in_progress') return faqs;

  const byTitle = new Map(
    (kb.knowledge_base_sources ?? []).flatMap((s) => (s.type === 'text' ? [[s.title, s.source_id] as const] : []))
  );
  const updated = new Map<string, Faq>();
  for (const faq of pending) {
    const sourceId = byTitle.get(sourceTitle(faq));
    // Retell can report "complete" for a moment before it picks up a new text
    if (!sourceId && Date.now() - new Date(faq.updated_at).getTime() < SYNC_GRACE_MS) continue;
    const patch = sourceId ? { status: 'ready' as const, retell_source_id: sourceId } : { status: 'error' as const };
    await db().from('va_agent_faqs').update(patch).eq('workspace_id', workspace.id).eq('id', faq.id);
    updated.set(faq.id, { ...faq, ...patch });
  }
  return faqs.map((f) => updated.get(f.id) ?? f);
}

export async function listFaqs(workspace: Workspace): Promise<Faq[]> {
  const { data, error } = await db()
    .from('va_agent_faqs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load FAQs: ${error.message}`);
  return reconcile(workspace, data as Faq[]);
}

/** Adds an FAQ. It reaches live calls as soon as Retell finishes indexing (seconds to a minute). */
export async function createFaq(
  workspace: Workspace,
  userId: string,
  input: FaqInput,
  origin: Faq['origin'] = 'manual'
): Promise<Faq> {
  const { count } = await db()
    .from('va_agent_faqs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspace.id);
  if ((count ?? 0) >= MAX_FAQS) throw new KbError(`Up to ${MAX_FAQS} FAQ entries`, 400);
  await assertWithinLimit(workspace, 'faqs', count ?? 0);

  const { data, error } = await db()
    .from('va_agent_faqs')
    .insert({ website_id: WEBSITE_ID, workspace_id: workspace.id, ...input, origin, created_by: userId })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to save FAQ: ${error.message}`);
  const faq = data as Faq;

  try {
    await addKbSources(workspace, { texts: [{ title: sourceTitle(faq), text: sourceText(input) }] });
  } catch (err) {
    await db().from('va_agent_faqs').delete().eq('id', faq.id);
    throw err;
  }
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Added FAQ: “${input.question.slice(0, 120)}”`, userId });
  return (await reconcile(workspace, [faq]))[0];
}

function assertSynced(faq: Faq) {
  if (faq.status === 'syncing') {
    throw new KbError('This FAQ is still being added to the knowledge base. Try again in a minute.', 409);
  }
}

/** Replaces the FAQ's knowledge base source (Retell texts can't be edited in place). */
export async function updateFaq(workspace: Workspace, userId: string, id: string, input: FaqInput): Promise<Faq> {
  let faq = await findFaq(workspace, id);
  if (!faq) throw new KbError('FAQ not found', 404);
  faq = (await reconcile(workspace, [faq]))[0];
  assertSynced(faq);

  await addKbSources(workspace, { texts: [{ title: sourceTitle({ id, question: input.question }), text: sourceText(input) }] });
  if (faq.retell_source_id) await removeKbSource(workspace, faq.retell_source_id);

  const { data, error } = await db()
    .from('va_agent_faqs')
    .update({ ...input, status: 'syncing', retell_source_id: null, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to save FAQ: ${error.message}`);
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Edited FAQ: “${input.question.slice(0, 120)}”`, userId });
  return (await reconcile(workspace, [data as Faq]))[0];
}

export async function deleteFaq(workspace: Workspace, userId: string, id: string): Promise<void> {
  let faq = await findFaq(workspace, id);
  if (!faq) throw new KbError('FAQ not found', 404);
  faq = (await reconcile(workspace, [faq]))[0];
  assertSynced(faq);

  if (faq.retell_source_id) await removeKbSource(workspace, faq.retell_source_id);
  const { error } = await db().from('va_agent_faqs').delete().eq('workspace_id', workspace.id).eq('id', id);
  if (error) throw new Error(`Failed to delete FAQ: ${error.message}`);
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Deleted FAQ: “${faq.question.slice(0, 120)}”`, userId });
}
