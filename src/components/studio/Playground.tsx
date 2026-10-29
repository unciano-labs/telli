'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw, Send } from 'lucide-react';
import { useWorkspaceApi } from '@/components/workspace/WorkspaceContext';

type Message = { role: 'agent' | 'user'; content: string };

/** Text chat with the draft or live agent: quick checks without voice minutes. */
export default function Playground({ greeting, hasLive }: { greeting: string; hasLive: boolean }) {
  const api = useWorkspaceApi();
  const [version, setVersion] = useState<'draft' | 'live'>('draft');
  const [messages, setMessages] = useState<Message[]>([{ role: 'agent', content: greeting }]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  function reset(next = version) {
    setVersion(next);
    setMessages([{ role: 'agent', content: greeting }]);
    setError(null);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || thinking) return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next);
    setText('');
    setThinking(true);
    setError(null);
    try {
      const res = await fetch(`${api}/playground`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, messages: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'No reply');
      setMessages([...next, ...(data.replies as string[]).map((r) => ({ role: 'agent' as const, content: r }))]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setThinking(false);
    }
  }

  return (
    <section aria-labelledby="playground-heading" className="flex flex-col rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="playground-heading" className="text-base font-semibold text-slate-900">
            Chat with your agent
          </h2>
          <p className="mt-1 text-sm text-slate-500">Type like a caller would. Free: no voice minutes used.</p>
        </div>
        <div className="flex items-center gap-2">
          {hasLive && (
            <div role="radiogroup" aria-label="Version to test" className="inline-flex rounded-full bg-slate-100 p-1 text-sm">
              {(['draft', 'live'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={version === v}
                  onClick={() => reset(v)}
                  className={`rounded-full px-3 py-1 font-medium transition ${version === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {v === 'draft' ? 'Draft' : 'Live'}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => reset()}
            aria-label="Start over"
            title="Start over"
            className="rounded-full p-2 text-slate-400 ring-1 ring-slate-200 hover:text-slate-700"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={listRef} className="mt-4 h-80 space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-sm" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <p
              className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
            >
              {m.content}
            </p>
          </div>
        ))}
        {thinking && (
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask something a caller would ask…"
          aria-label="Message"
          className="block w-full rounded-full border-0 px-4 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600"
        />
        <button
          disabled={!text.trim() || thinking}
          aria-label="Send"
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-indigo-600 px-4 text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </section>
  );
}
