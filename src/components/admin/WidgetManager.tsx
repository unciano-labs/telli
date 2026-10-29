'use client';

import { useState, useSyncExternalStore } from 'react';
import { Check, CheckCircle2, Copy, Loader2, Plus, Save, Trash2, XCircle } from 'lucide-react';
import { embedSnippet, normalizeOrigin } from '@/lib/widget-config';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

export type WidgetView = {
  id: string;
  public_key: string;
  name: string;
  allowed_origins: string[];
  title: string;
  button_label: string;
  accent_color: string;
  position: 'right' | 'left';
  enabled: boolean;
  updated_at: string;
};

type Draft = Omit<WidgetView, 'id' | 'public_key' | 'updated_at' | 'allowed_origins'> & { origins: string };
type Toast = { kind: 'success' | 'error'; text: string } | null;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

function toDraft(w: WidgetView): Draft {
  return {
    name: w.name,
    title: w.title,
    button_label: w.button_label,
    accent_color: w.accent_color,
    position: w.position,
    enabled: w.enabled,
    origins: w.allowed_origins.join('\n'),
  };
}

function Feedback({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return (
    <p
      role="status"
      className={`flex items-center gap-1.5 text-sm ${toast.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
    >
      {toast.kind === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
      {toast.text}
    </p>
  );
}

export default function WidgetManager({ initialWidgets }: { initialWidgets: WidgetView[] }) {
  const api = useWorkspaceApi();
  const [widgets, setWidgets] = useState(initialWidgets);
  const [selectedId, setSelectedId] = useState<string | null>(initialWidgets[0]?.id ?? null);
  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createToast, setCreateToast] = useState<Toast>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateToast(null);
    try {
      const res = await fetch(`${api}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not create the widget');
      setWidgets((list) => [...list, data.widget]);
      setSelectedId(data.widget.id);
      setNewName('');
    } catch (err) {
      setCreateToast({ kind: 'error', text: err instanceof Error ? err.message : 'Could not create the widget' });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-4">
        <ul className="space-y-1">
          {widgets.map((w) => (
            <li key={w.id}>
              <button
                onClick={() => setSelectedId(w.id)}
                aria-current={w.id === selectedId ? 'true' : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${w.id === selectedId ? 'bg-white font-medium text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/60'}`}
              >
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: w.accent_color }} />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {!w.enabled && <span className="text-xs text-slate-400">Off</span>}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={create} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
          <label className="block text-xs font-medium text-slate-600">
            New widget
            <input
              className={inputCls}
              placeholder="e.g. Main website"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create widget
          </button>
          <div className="mt-2">
            <Feedback toast={createToast} />
          </div>
        </form>
      </aside>

      {selected ? (
        <WidgetEditor
          key={selected.id}
          widget={selected}
          onSaved={(w) => setWidgets((list) => list.map((x) => (x.id === w.id ? w : x)))}
          onDeleted={(id) => {
            const rest = widgets.filter((w) => w.id !== id);
            setWidgets(rest);
            setSelectedId(rest[0]?.id ?? null);
          }}
        />
      ) : (
        <div className="flex min-h-64 items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
          Create a widget to get an embed code for your website.
        </div>
      )}
    </div>
  );
}

function WidgetEditor({
  widget,
  onSaved,
  onDeleted,
}: {
  widget: WidgetView;
  onSaved: (w: WidgetView) => void;
  onDeleted: (id: string) => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(widget));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [copied, setCopied] = useState(false);
  const api = useWorkspaceApi();
  // The snippet points at wherever this admin is served from; unknown during SSR
  const appOrigin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => ''
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(widget));
  const originLines = draft.origins.split('\n').map((l) => l.trim()).filter(Boolean);
  const invalidOrigins = originLines.filter((l) => !normalizeOrigin(l));
  const snippet = appOrigin ? embedSnippet(appOrigin, widget.public_key) : '';

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setToast(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const { origins, ...rest } = draft;
      const res = await fetch(`${api}/widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rest, allowed_origins: originLines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      onSaved(data.widget);
      setDraft(toDraft(data.widget));
      setToast({ kind: 'success', text: origins.trim() ? 'Widget saved.' : 'Saved. Add a website so the widget can be embedded.' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${widget.name}"? Sites using its embed code will stop showing the widget.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`${api}/widgets/${widget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Delete failed');
      onDeleted(widget.id);
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
      setDeleting(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-sm font-medium text-slate-700">Embed code</h2>
          <p className="mt-1 text-xs text-slate-400">
            Paste before the closing <code>&lt;/body&gt;</code> tag on every page that should show the widget.
          </p>
          <div className="mt-3 flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2.5 text-xs text-slate-100">
              {snippet || ' '}
            </pre>
            <button
              type="button"
              onClick={copy}
              disabled={!snippet}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {widget.allowed_origins.length === 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              No websites are allowed yet, so browsers will block this widget on other sites. Add your website below.
            </p>
          )}
        </section>

        <form onSubmit={save} className="space-y-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-slate-700">Settings</h2>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              Enabled
            </label>
          </div>

          <label className="block text-sm font-medium text-slate-700">
            Name <span className="font-normal text-slate-400">(only you see this)</span>
            <input className={inputCls} value={draft.name} maxLength={80} required onChange={(e) => set('name', e.target.value)} />
          </label>

          <label className="block text-sm font-medium text-slate-700">
            Allowed websites
            <textarea
              className={`${inputCls} font-mono`}
              rows={3}
              placeholder={'https://example.com\nhttps://*.example.com'}
              value={draft.origins}
              onChange={(e) => set('origins', e.target.value)}
            />
            <span className={`mt-1 block text-xs font-normal ${invalidOrigins.length ? 'text-red-600' : 'text-slate-400'}`}>
              {invalidOrigins.length
                ? `Not a valid address: ${invalidOrigins.join(', ')}`
                : 'One per line. Use *.example.com to allow all subdomains. Other sites can’t embed this widget.'}
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Panel title
              <input className={inputCls} value={draft.title} maxLength={60} required onChange={(e) => set('title', e.target.value)} />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Button label
              <input
                className={inputCls}
                value={draft.button_label}
                maxLength={30}
                required
                onChange={(e) => set('button_label', e.target.value)}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Accent color
              <span className="mt-1 flex items-center gap-2">
                <input
                  type="color"
                  value={draft.accent_color}
                  onChange={(e) => set('accent_color', e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-lg border-0 bg-transparent p-0"
                  aria-label="Pick accent color"
                />
                <input
                  className={`${inputCls} mt-0 font-mono`}
                  value={draft.accent_color}
                  maxLength={7}
                  onChange={(e) => set('accent_color', e.target.value)}
                />
              </span>
            </label>
            <fieldset className="text-sm font-medium text-slate-700">
              <legend>Position</legend>
              <div className="mt-2 flex gap-4 font-normal text-slate-600">
                {(['right', 'left'] as const).map((p) => (
                  <label key={p} className="flex items-center gap-2 capitalize">
                    <input
                      type="radio"
                      name="position"
                      checked={draft.position === p}
                      onChange={() => set('position', p)}
                      className="border-slate-300 text-indigo-600"
                    />
                    Bottom {p}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-500 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete widget
            </button>
            <div className="flex items-center gap-3">
              <Feedback toast={toast} />
              <button
                type="submit"
                disabled={!dirty || saving || invalidOrigins.length > 0}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </button>
            </div>
          </div>
        </form>
      </div>

      <section>
        <h2 className="text-sm font-medium text-slate-700">Live preview</h2>
        <p className="mt-1 text-xs text-slate-400">
          Shows saved settings. Calls from here are real and logged as admin tests.
        </p>
        <div className="mt-3 h-[600px] w-full max-w-[380px] overflow-hidden rounded-2xl bg-[repeating-linear-gradient(45deg,#f1f5f9_0_10px,#f8fafc_10px_20px)] shadow-sm ring-1 ring-slate-200">
          {widget.enabled ? (
            <iframe
              key={widget.updated_at}
              src={`/embed/${widget.public_key}?preview=1`}
              title={`${widget.name} preview`}
              allow="microphone; autoplay"
              className="h-full w-full border-0"
            />
          ) : (
            <p className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
              This widget is turned off, so sites using its embed code don’t show it.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
