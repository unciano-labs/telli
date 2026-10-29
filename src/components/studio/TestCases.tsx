'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, Loader2, Pencil, Play, Plus, Trash2, XCircle } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { hasRole } from '@/lib/workspace-roles';

export type TestCaseView = { id: string; name: string; caller: string; expectation: string };
export type TestRunView = {
  status: 'running' | 'complete';
  pass_count: number;
  fail_count: number;
  error_count: number;
  total_count: number;
  results: { test_case_id: string; name: string; status: string; explanation: string | null }[];
  draft_changed_at: string | null;
  completed_at: string | null;
  created_at: string;
};

type Draft = Omit<TestCaseView, 'id'>;
const EMPTY: Draft = { name: '', caller: '', expectation: '' };
const POLL_MS = 5000;

const inputCls =
  'mt-1 block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

function ResultIcon({ status }: { status: string | undefined }) {
  if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Passed" />;
  if (status === 'fail' || status === 'error') return <XCircle className="h-4 w-4 text-red-600" aria-label="Failed" />;
  if (status === 'pending' || status === 'in_progress') return <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-label="Running" />;
  return <CircleDashed className="h-4 w-4 text-slate-300" aria-label="Not run" />;
}

/** Saved questions with the expected behavior, run against the draft before publishing. */
export default function TestCases({
  initialCases,
  initialRun,
  draftChangedAt,
}: {
  initialCases: TestCaseView[];
  initialRun: TestRunView | null;
  draftChangedAt: string | null;
}) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const canEdit = hasRole(role, 'admin');
  const [cases, setCases] = useState(initialCases);
  const [run, setRun] = useState(initialRun);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`${api}/tests`);
    if (!res.ok) return;
    const data = await res.json();
    setCases(data.cases);
    setRun(data.run);
  }, [api]);

  const running = run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const resultFor = (id: string) => (running ? undefined : run?.results.find((r) => r.test_case_id === id));
  const stale = run && run.status === 'complete' && run.draft_changed_at !== draftChangedAt;

  async function call(url: string, method: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
    return data;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const id = editing === 'new' ? null : editing;
    setBusy(id ?? 'new');
    setError(null);
    try {
      const data = await call(id ? `${api}/tests?id=${id}` : `${api}/tests`, id ? 'PATCH' : 'POST', draft);
      setCases((list) => (id ? list.map((c) => (c.id === id ? data.testCase : c)) : [...list, data.testCase]));
      setEditing(null);
      setDraft(EMPTY);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(testCase: TestCaseView) {
    if (!window.confirm(`Delete the test “${testCase.name}”?`)) return;
    setBusy(testCase.id);
    try {
      await call(`${api}/tests?id=${testCase.id}`, 'DELETE');
      setCases((list) => list.filter((c) => c.id !== testCase.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runAll() {
    setBusy('run');
    setError(null);
    try {
      const data = await call(`${api}/tests/run`, 'POST');
      setRun({ ...data.run, results: [] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const form = (
    <form onSubmit={save} className="space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <label className="block text-sm font-medium text-slate-700">
        Name
        <input className={inputCls} required maxLength={120} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Refund after 10 days" />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        What the caller does
        <textarea
          className={inputCls}
          rows={2}
          required
          maxLength={1000}
          value={draft.caller}
          onChange={(e) => setDraft((d) => ({ ...d, caller: e.target.value }))}
          placeholder="You bought a shirt 10 days ago and want your money back."
        />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        A good answer…
        <input
          className={inputCls}
          required
          maxLength={500}
          value={draft.expectation}
          onChange={(e) => setDraft((d) => ({ ...d, expectation: e.target.value }))}
          placeholder="Explains returns are only within 7 days and offers an exchange instead"
        />
      </label>
      <div className="flex gap-2">
        <button disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {busy && busy !== 'run' && <Loader2 className="h-4 w-4 animate-spin" />} Save test
        </button>
        <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <section aria-labelledby="tests-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="tests-heading" className="text-base font-semibold text-slate-900">
            Test cases
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            An AI caller plays each one against your draft and checks the answer. Run them before you publish.
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {editing === null && (
              <button
                type="button"
                onClick={() => {
                  setEditing('new');
                  setDraft(EMPTY);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
              >
                <Plus className="h-4 w-4" /> Add
              </button>
            )}
            <button
              type="button"
              onClick={runAll}
              disabled={running || busy === 'run' || cases.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {running || busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? 'Running…' : 'Run all'}
            </button>
          </div>
        )}
      </div>

      {run && run.status === 'complete' && (
        <p
          className={`mt-4 rounded-xl px-3 py-2 text-sm ${run.fail_count + run.error_count ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}
        >
          Last run: {run.pass_count} of {run.total_count} passed
          {run.completed_at && ` · ${new Date(run.completed_at).toLocaleString()}`}
          {stale && <span className="text-amber-700"> · the draft changed since, run again before publishing</span>}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {editing === 'new' && <div className="mt-4">{form}</div>}

      {cases.length === 0 && editing === null && (
        <p className="mt-4 text-sm text-slate-500">
          No test cases yet. Add the questions that must always be answered right, like prices, hours and refunds.
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {cases.map((c) => {
          const result = resultFor(c.id);
          return editing === c.id ? (
            <li key={c.id}>{form}</li>
          ) : (
            <li key={c.id} className="rounded-xl p-4 ring-1 ring-slate-200">
              <div className="flex items-start gap-3">
                <span className="mt-0.5">
                  <ResultIcon status={running ? 'in_progress' : result?.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{c.name}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    <span className="font-medium text-slate-600">Caller:</span> {c.caller}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="font-medium text-slate-600">Expect:</span> {c.expectation}
                  </p>
                  {result?.explanation && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{result.explanation}</p>}
                </div>
                {canEdit && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(c.id);
                        setDraft({ name: c.name, caller: c.caller, expectation: c.expectation });
                      }}
                      aria-label={`Edit test: ${c.name}`}
                      className="rounded p-1.5 text-slate-400 hover:text-slate-700"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(c)}
                      disabled={busy === c.id}
                      aria-label={`Delete test: ${c.name}`}
                      className="rounded p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
