'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CalendarCheck, Check, Home, Loader2 } from 'lucide-react';
import { TEMPLATES, type TemplateId } from '@/lib/templates';
import { MODULES, modulesForTemplate, type ModuleId } from '@/lib/modules-shared';

const MODULE_ICONS: Record<ModuleId, typeof Home> = { reservations: CalendarCheck, rentals: Home };

export default function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TemplateId>('support');
  const [modules, setModules] = useState<ModuleId[]>([]);
  const [samples, setSamples] = useState(true);

  function chooseTemplate(id: TemplateId) {
    setTemplate(id);
    setModules(modulesForTemplate(id));
  }
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          template,
          modules,
          samples,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not create the workspace.');
      router.push(`/w/${data.workspace.slug}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <section>
        <label htmlFor="business-name" className="text-sm font-semibold text-slate-900">
          1. Your business name
        </label>
        <p className="mt-1 text-sm text-slate-500">Your agent introduces itself with this name.</p>
        <input
          id="business-name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Smile Bright Dental"
          className="mt-3 block w-full max-w-md rounded-lg border-0 px-3 py-2.5 text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600"
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-900">2. What should your agent do?</h2>
        <p className="mt-1 text-sm text-slate-500">This sets a starting prompt and greeting. You can change both later.</p>
        <div role="radiogroup" aria-label="Agent template" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((t) => {
            const active = t.id === template;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => chooseTemplate(t.id)}
                className={`rounded-2xl p-4 text-left transition ${active ? 'bg-white shadow-sm ring-2 ring-indigo-600' : 'bg-white/60 ring-1 ring-slate-200 hover:bg-white'}`}
              >
                <p className="font-medium text-slate-900">{t.label}</p>
                <p className="mt-1 text-sm text-slate-500">{t.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-900">3. Let it take bookings (optional)</h2>
        <p className="mt-1 text-sm text-slate-500">
          Modules let your agent check what’s free and book it during the call. You can turn them on or off later.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(Object.keys(MODULES) as ModuleId[]).map((m) => {
            const on = modules.includes(m);
            const Icon = MODULE_ICONS[m];
            return (
              <button
                key={m}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => setModules((list) => (on ? list.filter((x) => x !== m) : [...list, m]))}
                className={`flex gap-3 rounded-2xl p-4 text-left transition ${on ? 'bg-white shadow-sm ring-2 ring-indigo-600' : 'bg-white/60 ring-1 ring-slate-200 hover:bg-white'}`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${on ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                  {on ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </span>
                <span>
                  <span className="block font-medium text-slate-900">{MODULES[m].label}</span>
                  <span className="mt-1 block text-sm text-slate-500">{MODULES[m].description}</span>
                </span>
              </button>
            );
          })}
        </div>
        {modules.length > 0 && (
          <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} className="rounded text-indigo-600" />
            Add sample {modules.includes('rentals') ? 'apartments' : 'services'} so I can try a booking right away
          </label>
        )}
      </section>

      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        disabled={creating || !name.trim()}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-3 font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-60"
      >
        {creating ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" /> Setting up your agent…
          </>
        ) : (
          <>
            Create my agent <ArrowRight className="h-5 w-5" />
          </>
        )}
      </button>
    </form>
  );
}
