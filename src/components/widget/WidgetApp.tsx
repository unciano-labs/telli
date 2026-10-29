'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Headset, Mic, MicOff, Phone, PhoneOff, ThumbsDown, ThumbsUp } from 'lucide-react';
import { fetchCallToken, formatDuration, useRetellCall } from '@/components/call/useRetellCall';

export type WidgetProps = {
  widgetKey: string;
  agentName: string;
  title: string;
  buttonLabel: string;
  accentColor: string;
  position: 'right' | 'left';
  /** Admin preview: opens immediately, calls are logged as tests, no funnel events. */
  preview: boolean;
  /** Host page (origin + path) passed by the loader script. */
  pageUrl: string | null;
};

type WidgetEvent = 'loaded' | 'opened' | 'call_started' | 'call_ended';

/** Messages to the loader script (public/widget.js) on the host page. */
function postToHost(message: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage({ source: 'voice-agent', ...message }, '*');
}

function getVisitorId(): string | null {
  // Partitioned per host site by the browser; used only for unique-visitor counts
  try {
    let id = localStorage.getItem('va_visitor');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('va_visitor', id);
    }
    return id;
  } catch {
    return null;
  }
}

/** White text on dark accents, dark text on light ones. */
function readableOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#0f172a' : '#ffffff';
}

type Rating = 'up' | 'down';

/** 👍 / 👎 after a call, with an optional comment. Keyed by call id so each call starts fresh. */
function CallFeedback({ onSend }: { onSend: (rating: Rating, comment: string) => void }) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) return <p className="mx-4 mt-3 text-center text-sm text-slate-500">Thanks for your feedback!</p>;

  function send(withComment: boolean) {
    onSend(rating!, withComment ? comment.trim() : '');
    setSent(true);
  }

  return (
    <div className="mx-4 mt-3 rounded-2xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-slate-700">How was this call?</p>
        <div className="flex gap-1.5">
          {(['up', 'down'] as const).map((r) => {
            const Icon = r === 'up' ? ThumbsUp : ThumbsDown;
            return (
              <button
                key={r}
                onClick={() => setRating(r)}
                aria-pressed={rating === r}
                aria-label={r === 'up' ? 'Helpful' : 'Not helpful'}
                className={`flex h-9 w-9 items-center justify-center rounded-full transition ${rating === r ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900'}`}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      </div>
      {rating && (
        <div className="mt-2 space-y-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder={rating === 'down' ? 'What went wrong? (optional)' : 'Anything to add? (optional)'}
            className="block w-full resize-none rounded-xl border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-[var(--accent)]"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => send(false)} className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700">
              Skip comment
            </button>
            <button
              onClick={() => send(true)}
              className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--on-accent)] transition hover:brightness-110"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WidgetUnavailable() {
  useEffect(() => postToHost({ type: 'hide' }), []);
  return null;
}

export default function WidgetApp({
  widgetKey,
  agentName,
  title,
  buttonLabel,
  accentColor,
  position,
  preview,
  pageUrl,
}: WidgetProps) {
  const [open, setOpen] = useState(preview);
  const visitorRef = useRef<string | null>(null);
  const launcherRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // The admin preview runs on this app itself, so its own URL is the page
  const currentPage = useCallback(() => pageUrl ?? window.location.href, [pageUrl]);

  const track = useCallback(
    (event: WidgetEvent) => {
      if (preview) return;
      fetch(`/api/widget/${widgetKey}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, visitorId: visitorRef.current, pageUrl: currentPage() }),
        keepalive: true,
      }).catch(() => {});
    },
    [preview, widgetKey, currentPage]
  );

  const call = useRetellCall({
    requestToken: () =>
      fetchCallToken(`/api/widget/${widgetKey}/call`, {
        visitorId: visitorRef.current,
        pageUrl: currentPage(),
        preview,
      }),
    onStarted: () => track('call_started'),
    onEnded: () => track('call_ended'),
  });
  const { status, error, muted, agentTalking, transcript, seconds, lastCall } = call;
  const inCall = status !== 'idle';

  useEffect(() => {
    if (preview) return;
    visitorRef.current = getVisitorId();
    track('loaded');
    // Once per page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tell the host page how big the iframe should be
  useEffect(() => {
    if (open) {
      postToHost({ type: 'layout', open: true, position });
      return;
    }
    const el = launcherRef.current;
    if (!el) return;
    const report = () =>
      postToHost({ type: 'layout', open: false, position, width: el.offsetWidth, height: el.offsetHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, position]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  function sendFeedback(callId: string, rating: Rating, comment: string) {
    fetch(`/api/widget/${widgetKey}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, rating, comment: comment || null, pageUrl: currentPage() }),
      keepalive: true,
    }).catch(() => {});
  }

  function openPanel() {
    setOpen(true);
    track('opened');
  }

  const style = { '--accent': accentColor, '--on-accent': readableOn(accentColor) } as CSSProperties;
  const side = position === 'left' ? 'left-0' : 'right-0';

  if (!open) {
    return (
      <div ref={launcherRef} style={style} className={`fixed bottom-0 ${side} p-3`}>
        <button
          onClick={openPanel}
          className="flex items-center gap-2 rounded-full bg-[var(--accent)] py-3 pl-4 pr-5 text-sm font-semibold text-[var(--on-accent)] shadow-lg ring-1 ring-black/5 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          {inCall ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              On call · {formatDuration(seconds)}
            </>
          ) : (
            <>
              <Phone className="h-4 w-4" />
              {buttonLabel}
            </>
          )}
        </button>
      </div>
    );
  }

  return (
    <div style={style} className="fixed inset-0 flex flex-col overflow-hidden bg-white text-slate-900">
      <header className="flex items-center gap-3 bg-[var(--accent)] px-4 py-3 text-[var(--on-accent)]">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
          <Headset className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs opacity-80">
            {status === 'active' ? `On call · ${formatDuration(seconds)}` : status === 'connecting' ? 'Connecting…' : agentName}
          </p>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Minimize"
          className="rounded-full p-1.5 transition hover:bg-white/20"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      </header>

      <div className="flex flex-col items-center px-5 pt-6">
        <div className="relative flex h-20 w-20 items-center justify-center">
          {agentTalking && (
            <>
              <span className="speak-ring absolute inset-0 rounded-full bg-[var(--accent)]" />
              <span className="speak-ring absolute inset-0 rounded-full bg-[var(--accent)] [animation-delay:0.5s]" />
            </>
          )}
          <div
            className={`relative flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] shadow-md transition-transform ${agentTalking ? 'scale-105' : ''}`}
          >
            <Headset className="h-9 w-9" strokeWidth={1.5} />
          </div>
        </div>
        <p className="mt-3 text-sm text-slate-500">
          {status === 'active'
            ? agentTalking
              ? 'Speaking…'
              : muted
                ? 'Your mic is muted'
                : 'Listening…'
            : 'Ask anything — the agent answers right away.'}
        </p>
      </div>

      <div
        ref={transcriptRef}
        className="mx-4 mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-sm"
        aria-live="polite"
      >
        {transcript.length === 0 ? (
          <p className="flex h-full items-center justify-center text-center text-slate-400">
            {status === 'idle' ? 'The conversation will appear here.' : 'Waiting for the conversation…'}
          </p>
        ) : (
          transcript.map((u, i) => (
            <div key={i} className={`flex ${u.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <p
                className={`max-w-[85%] rounded-2xl px-3 py-2 ${u.role === 'user' ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
              >
                {u.content}
              </p>
            </div>
          ))
        )}
      </div>

      {!inCall && lastCall?.connected && (
        <CallFeedback key={lastCall.id} onSend={(rating, comment) => sendFeedback(lastCall.id, rating, comment)} />
      )}

      {error && (
        <p role="alert" className="mx-4 mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex items-center justify-center gap-4 px-4 py-4">
        {!inCall ? (
          <button
            onClick={call.start}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-6 py-3 font-medium text-white shadow-sm transition hover:bg-emerald-500"
          >
            <Phone className="h-5 w-5" /> Start call
          </button>
        ) : (
          <>
            <button
              onClick={call.toggleMute}
              disabled={status !== 'active'}
              aria-pressed={muted}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              className={`flex h-12 w-12 items-center justify-center rounded-full transition disabled:opacity-40 ${muted ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            >
              {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
            <button
              onClick={call.end}
              aria-label="End call"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition hover:bg-red-500"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          </>
        )}
      </div>
      <p className="pb-3 text-center text-[11px] text-slate-400">AI voice agent · calls are limited to 5 minutes</p>
    </div>
  );
}
