'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, Trash2, UploadCloud } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { ALLOWED_EXTENSIONS, KB_BUCKET, validateKbFile } from '@/lib/constants';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

type Doc = {
  id: string;
  file_name: string;
  file_size: number;
  status: 'indexing' | 'ready' | 'error';
  created_at: string;
};

type UploadItem = {
  key: string;
  name: string;
  stage: 'queued' | 'uploading' | 'syncing' | 'done' | 'error';
  error?: string;
};

const POLL_MS = 5000;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export default function DocumentManager({ initialDocuments }: { initialDocuments: Doc[] }) {
  const api = useWorkspaceApi();
  const [docs, setDocs] = useState<Doc[]>(initialDocuments);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef(Promise.resolve());

  const updateUpload = (key: string, patch: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  const refresh = useCallback(async () => {
    const res = await fetch(`${api}/docs`);
    if (res.ok) setDocs((await res.json()).documents);
  }, [api]);

  // Retell indexes asynchronously; poll until every document settles
  const indexing = docs.some((d) => d.status === 'indexing');
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [indexing, refresh]);

  async function uploadOne(file: File, key: string) {
    try {
      updateUpload(key, { stage: 'uploading' });
      const slot = await postJson(`${api}/docs/upload-url`, { fileName: file.name, fileSize: file.size });
      const { error } = await createClient()
        .storage.from(KB_BUCKET)
        .uploadToSignedUrl(slot.path, slot.token, file, { contentType: file.type || undefined });
      if (error) throw new Error(`Upload failed: ${error.message}`);

      updateUpload(key, { stage: 'syncing' });
      const { document } = await postJson(`${api}/docs`, { storagePath: slot.path, fileName: file.name });
      setDocs((list) => [document, ...list]);
      updateUpload(key, { stage: 'done' });
      setTimeout(() => setUploads((list) => list.filter((u) => u.key !== key)), 3000);
    } catch (err) {
      updateUpload(key, { stage: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
    }
  }

  function addFiles(files: FileList | File[]) {
    const items: UploadItem[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${crypto.randomUUID()}`;
      const invalid = validateKbFile(file.name, file.size);
      items.push({ key, name: file.name, stage: invalid ? 'error' : 'queued', error: invalid ?? undefined });
      // Upload one at a time so the first upload creates the knowledge base before others append to it
      if (!invalid) queueRef.current = queueRef.current.then(() => uploadOne(file, key));
    }
    setUploads((list) => [...items, ...list]);
  }

  async function remove(doc: Doc) {
    if (!confirm(`Delete “${doc.file_name}”? The agent will no longer use it to answer questions.`)) return;
    setDeleting(doc.id);
    setListError(null);
    try {
      const res = await fetch(`${api}/docs?id=${doc.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Delete failed');
      setDocs((list) => list.filter((d) => d.id !== doc.id));
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-base font-semibold text-slate-900">Knowledge base</h2>
      <p className="mt-1 text-xs text-slate-400">The agent answers questions using these documents.</p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        className={`mt-5 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${dragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-400'}`}
      >
        <UploadCloud className="h-8 w-8 text-slate-400" />
        <p className="mt-2 text-sm font-medium text-slate-700">Drop files or click to upload</p>
        <p className="mt-1 text-xs text-slate-400">{ALLOWED_EXTENSIONS.join(', ')} · up to 10 MB each</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(',')}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {uploads.length > 0 && (
        <ul className="mt-4 space-y-2">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              {u.stage === 'error' ? (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              ) : u.stage === 'done' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-indigo-600" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-slate-700">{u.name}</p>
                <p className={`text-xs ${u.stage === 'error' ? 'text-red-600' : 'text-slate-400'}`}>
                  {u.stage === 'queued' && 'Waiting…'}
                  {u.stage === 'uploading' && 'Uploading to storage…'}
                  {u.stage === 'syncing' && 'Sending to Retell knowledge base…'}
                  {u.stage === 'done' && 'Uploaded'}
                  {u.stage === 'error' && u.error}
                </p>
              </div>
              {u.stage === 'error' && (
                <button
                  onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  Dismiss
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {listError && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {listError}
        </p>
      )}

      <ul className="mt-5 divide-y divide-slate-100">
        {docs.length === 0 && <li className="py-6 text-center text-sm text-slate-400">No documents yet.</li>}
        {docs.map((doc) => (
          <li key={doc.id} className="flex items-center gap-3 py-3">
            <FileText className="h-5 w-5 shrink-0 text-slate-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-800" title={doc.file_name}>
                {doc.file_name}
              </p>
              <p className="text-xs text-slate-400">
                {formatSize(doc.file_size)} · {new Date(doc.created_at).toLocaleDateString()}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                doc.status === 'ready'
                  ? 'bg-emerald-50 text-emerald-700'
                  : doc.status === 'error'
                    ? 'bg-red-50 text-red-700'
                    : 'bg-amber-50 text-amber-700'
              }`}
            >
              {doc.status === 'indexing' ? 'Indexing…' : doc.status === 'ready' ? 'Ready' : 'Failed'}
            </span>
            <button
              onClick={() => remove(doc)}
              disabled={deleting === doc.id}
              aria-label={`Delete ${doc.file_name}`}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              {deleting === doc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
