import 'server-only';
import { toFile } from 'retell-sdk';
import type { KnowledgeBaseResponse } from 'retell-sdk/resources/knowledge-base';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { KB_BUCKET, MAX_FILE_SIZE, validateKbFile } from '@/lib/constants';
import { logChange, prepareDraft } from '@/lib/agent-draft';
import type { Workspace } from '@/lib/workspaces';
import { assertWithinLimit } from '@/lib/billing';

export type AgentDocument = {
  id: string;
  website_id: string;
  workspace_id: string;
  file_name: string;
  file_size: number;
  storage_path: string;
  retell_source_id: string | null;
  status: 'indexing' | 'ready' | 'error';
  created_at: string;
};

export class KbError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

// Retell caps KB names at 40 characters
function kbName(workspace: Workspace) {
  return `${workspace.slug.slice(0, 32)} KB`;
}

/** Storage folder for a workspace's files. */
function storagePrefix(workspace: Workspace) {
  return `${WEBSITE_ID}/${workspace.id}/`;
}

function db() {
  return createAdminClient();
}

/** Issues a short-lived signed URL so the browser uploads directly to Storage (bypasses the 4.5 MB serverless body limit). */
export async function createSignedUpload(workspace: Workspace, fileName: string, fileSize: number) {
  const invalid = validateKbFile(fileName, fileSize);
  if (invalid) throw new KbError(invalid, 400);
  const { count } = await db()
    .from('va_agent_documents')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id);
  await assertWithinLimit(workspace, 'documents', count ?? 0);

  const safeName = fileName.replace(/[^\w.-]+/g, '_').slice(-120);
  const path = `${storagePrefix(workspace)}${crypto.randomUUID()}-${safeName}`;

  const { data, error } = await db().storage.from(KB_BUCKET).createSignedUploadUrl(path);
  if (error) throw new KbError(`Could not create upload URL: ${error.message}`, 500);
  return { path: data.path, token: data.token };
}

/** Text kept in a knowledge base whose real sources were all removed (Retell won't delete the last one). */
export const PLACEHOLDER_TITLE = 'No business information yet';

/** The workspace's knowledge base, or null if nothing has been added yet. */
export async function retrieveKb(workspace: Workspace): Promise<KnowledgeBaseResponse | null> {
  const config = await prepareDraft(workspace);
  if (!config.retell_kb_id) return null;
  return getRetell().knowledgeBase.retrieve(config.retell_kb_id);
}

/**
 * Adds files, texts or web pages to the workspace's knowledge base, creating it on first
 * use. The knowledge base isn't versioned, so additions reach live calls straight away,
 * except a brand-new knowledge base: it's attached to the draft and goes live on Publish.
 */
export async function addKbSources(
  workspace: Workspace,
  sources: { files?: Awaited<ReturnType<typeof toFile>>[]; texts?: { title: string; text: string }[]; urls?: string[] }
): Promise<KnowledgeBaseResponse> {
  const retell = getRetell();
  const config = await prepareDraft(workspace);
  const payload = {
    ...(sources.files?.length && { knowledge_base_files: sources.files }),
    ...(sources.texts?.length && { knowledge_base_texts: sources.texts }),
    ...(sources.urls?.length && { knowledge_base_urls: sources.urls }),
  };

  if (config.retell_kb_id) return retell.knowledgeBase.addSources(config.retell_kb_id, payload);

  const kb = await retell.knowledgeBase.create({
    knowledge_base_name: kbName(workspace),
    // Imported web pages re-scrape daily
    enable_auto_refresh: true,
    ...payload,
  });
  // Claim the KB slot atomically; if another request won the race, use theirs instead
  const { data: claimed } = await db()
    .from('va_agent_configs')
    .update({ retell_kb_id: kb.knowledge_base_id, draft_changed_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .is('retell_kb_id', null)
    .select('retell_kb_id');
  if (claimed?.length) {
    await retell.llm.update(config.retell_llm_id, { knowledge_base_ids: [kb.knowledge_base_id] });
    await logChange(workspace, {
      action: 'edit',
      scope: 'draft',
      summary: 'Connected the knowledge base (publish so callers can use it)',
      userId: null,
    });
    return kb;
  }
  await retell.knowledgeBase.delete(kb.knowledge_base_id);
  const winner = await prepareDraft(workspace);
  return retell.knowledgeBase.addSources(winner.retell_kb_id!, payload);
}

/**
 * Removes one source. Retell refuses to delete a knowledge base's last source, and live
 * versions keep pointing at the knowledge base, so a placeholder text takes its place.
 */
export async function removeKbSource(workspace: Workspace, sourceId: string): Promise<void> {
  const retell = getRetell();
  const kb = await retrieveKb(workspace);
  if (!kb) return;
  const others = (kb.knowledge_base_sources ?? []).filter((s) => s.source_id !== sourceId);
  if (others.length === 0) {
    await retell.knowledgeBase.addSources(kb.knowledge_base_id, {
      knowledge_base_texts: [{ title: PLACEHOLDER_TITLE, text: 'This business hasn’t added any information yet.' }],
    });
  }
  try {
    await retell.knowledgeBase.deleteSource(sourceId, { knowledge_base_id: kb.knowledge_base_id });
  } catch (error) {
    // Already gone from Retell is fine; anything else must stop the delete
    if ((error as { status?: number }).status !== 404) throw error;
  }
}

export type WebPage = { sourceId: string; url: string };

export type KbSummary = {
  status: KnowledgeBaseResponse['status'] | 'none';
  autoRefresh: boolean;
  lastRefreshedAt: string | null;
  pages: WebPage[];
};

/** Imported web pages and the knowledge base's processing state. */
export async function getKbSummary(workspace: Workspace): Promise<KbSummary> {
  const kb = await retrieveKb(workspace);
  if (!kb) return { status: 'none', autoRefresh: false, lastRefreshedAt: null, pages: [] };
  return {
    status: kb.status,
    autoRefresh: Boolean(kb.enable_auto_refresh),
    lastRefreshedAt: kb.last_refreshed_timestamp ? new Date(kb.last_refreshed_timestamp).toISOString() : null,
    pages: (kb.knowledge_base_sources ?? []).flatMap((s) => (s.type === 'url' ? [{ sourceId: s.source_id, url: s.url }] : [])),
  };
}

const MAX_PAGES = 25;

export function normalizePageAddress(value: string): string | null {
  try {
    const url = new URL(value.trim().match(/^https?:\/\//i) ? value.trim() : `https://${value.trim()}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') || ['localhost', '127.0.0.1'].includes(url.hostname)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export async function addWebPage(workspace: Workspace, userId: string, address: string): Promise<void> {
  const url = normalizePageAddress(address);
  if (!url) throw new KbError('Enter a full web address, like https://yourbusiness.com/faq', 400);
  const summary = await getKbSummary(workspace);
  if (summary.pages.some((p) => p.url === url)) throw new KbError('That page is already imported', 409);
  if (summary.pages.length >= MAX_PAGES) throw new KbError(`Up to ${MAX_PAGES} web pages`, 400);
  await assertWithinLimit(workspace, 'pages', summary.pages.length);
  await addKbSources(workspace, { urls: [url] });
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Imported web page ${url}`, userId });
}

export async function removeWebPage(workspace: Workspace, userId: string, sourceId: string): Promise<void> {
  const page = (await getKbSummary(workspace)).pages.find((p) => p.sourceId === sourceId);
  if (!page) throw new KbError('Page not found', 404);
  await removeKbSource(workspace, sourceId);
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Removed web page ${page.url}`, userId });
}

/** Re-scrapes one page now (by importing it again). */
export async function refreshWebPage(workspace: Workspace, userId: string, sourceId: string): Promise<void> {
  const page = (await getKbSummary(workspace)).pages.find((p) => p.sourceId === sourceId);
  if (!page) throw new KbError('Page not found', 404);
  await addKbSources(workspace, { urls: [page.url] });
  await removeKbSource(workspace, sourceId);
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Refreshed web page ${page.url}`, userId });
}

function documentSources(kb: KnowledgeBaseResponse) {
  return (kb.knowledge_base_sources ?? []).flatMap((s) =>
    s.type === 'document' && 'filename' in s ? [{ sourceId: s.source_id, filename: s.filename }] : []
  );
}

/** Finds the Retell source for a file that isn't already claimed by another document row. */
function matchSource(kb: KnowledgeBaseResponse, fileName: string, claimed: Set<string>) {
  return documentSources(kb).find((s) => s.filename === fileName && !claimed.has(s.sourceId));
}

async function claimedSourceIds(workspace: Workspace): Promise<Set<string>> {
  const { data } = await db()
    .from('va_agent_documents')
    .select('retell_source_id')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .not('retell_source_id', 'is', null);
  return new Set((data ?? []).map((d) => d.retell_source_id as string));
}

/**
 * Sends an uploaded Storage object to the Retell knowledge base and records it.
 * Creates the KB (and attaches it to the LLM) on the first upload.
 */
export async function ingestDocument(
  workspace: Workspace,
  input: { storagePath: string; fileName: string },
  userId: string | null = null
): Promise<AgentDocument> {
  const { storagePath, fileName } = input;
  // Only this workspace's folder: a path from the browser must never reach another workspace's file
  if (!storagePath.startsWith(storagePrefix(workspace)) || storagePath.includes('..')) {
    throw new KbError('Invalid storage path', 400);
  }

  const storage = db().storage.from(KB_BUCKET);
  const { data: blob, error: dlErr } = await storage.download(storagePath);
  if (dlErr || !blob) throw new KbError('Uploaded file not found in storage', 404);

  // Re-validate against the real object, not what the client claimed
  const invalid = validateKbFile(fileName, blob.size);
  if (invalid || blob.size > MAX_FILE_SIZE) {
    await storage.remove([storagePath]);
    throw new KbError(invalid ?? 'File exceeds the 10 MB limit', 400);
  }

  try {
    const kb = await addKbSources(workspace, { files: [await toFile(blob, fileName)] });
    const source = kb.status === 'complete' ? matchSource(kb, fileName, await claimedSourceIds(workspace)) : undefined;

    const { data: row, error: dbErr } = await db()
      .from('va_agent_documents')
      .insert({
        website_id: WEBSITE_ID,
        workspace_id: workspace.id,
        file_name: fileName,
        file_size: blob.size,
        storage_path: storagePath,
        retell_source_id: source?.sourceId ?? null,
        status: source ? 'ready' : 'indexing',
      })
      .select('*')
      .single();
    if (dbErr) throw new Error(`Failed to record document: ${dbErr.message}`);
    await logChange(workspace, { action: 'edit', scope: 'live', summary: `Uploaded ${fileName}`, userId });
    return row as AgentDocument;
  } catch (error) {
    await storage.remove([storagePath]);
    throw error;
  }
}

/**
 * Lists documents, first resolving any still marked "indexing" against Retell:
 * Retell only reports source IDs once the knowledge base finishes processing.
 */
export async function listDocuments(workspace: Workspace): Promise<AgentDocument[]> {
  await reconcileIndexing(workspace);
  const { data, error } = await db()
    .from('va_agent_documents')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load documents: ${error.message}`);
  return data as AgentDocument[];
}

async function reconcileIndexing(workspace: Workspace): Promise<void> {
  const { data: pending } = await db()
    .from('va_agent_documents')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .eq('status', 'indexing')
    .order('created_at', { ascending: true });
  if (!pending?.length) return;

  const kb = await retrieveKb(workspace);
  if (!kb || kb.status === 'in_progress' || kb.status === 'refreshing_in_progress') return;

  const claimed = await claimedSourceIds(workspace);
  for (const doc of pending as AgentDocument[]) {
    let update: Partial<AgentDocument>;
    if (kb.status === 'error') {
      update = { status: 'error' };
    } else if (doc.retell_source_id) {
      update = { status: 'ready' };
    } else {
      const source = matchSource(kb, doc.file_name, claimed);
      if (source) claimed.add(source.sourceId);
      update = source ? { status: 'ready', retell_source_id: source.sourceId } : { status: 'error' };
    }
    await db().from('va_agent_documents').update(update).eq('workspace_id', workspace.id).eq('id', doc.id);
  }
}

/** Removes the source from Retell first, then the Storage object, then the row. */
export async function deleteDocument(workspace: Workspace, id: string, userId: string | null = null): Promise<void> {
  const find = () =>
    db()
      .from('va_agent_documents')
      .select('*')
      .eq('id', id)
      .eq('website_id', WEBSITE_ID)
      .eq('workspace_id', workspace.id)
      .maybeSingle();

  let { data: doc } = await find();
  if (!doc) throw new KbError('Document not found', 404);

  if (!doc.retell_source_id && doc.status === 'indexing') {
    await reconcileIndexing(workspace);
    ({ data: doc } = await find());
    if (!doc) throw new KbError('Document not found', 404);
    if (!doc.retell_source_id && doc.status === 'indexing') {
      throw new KbError('Document is still being indexed by Retell. Try again in a minute.', 409);
    }
  }

  if (doc.retell_source_id) await removeKbSource(workspace, doc.retell_source_id);

  await db().storage.from(KB_BUCKET).remove([doc.storage_path]);
  const { error } = await db().from('va_agent_documents').delete().eq('workspace_id', workspace.id).eq('id', doc.id);
  if (error) throw new Error(`Failed to delete document record: ${error.message}`);
  await logChange(workspace, { action: 'edit', scope: 'live', summary: `Deleted ${doc.file_name}`, userId });
}
