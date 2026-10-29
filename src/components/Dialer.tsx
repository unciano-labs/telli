'use client';

import { useEffect, useRef } from 'react';
import { Headset, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { fetchCallToken, formatDuration, useRetellCall } from '@/components/call/useRetellCall';

export default function Dialer({
  agentName,
  endpoint = '/api/call/create',
  tagline = 'AI voice support, available 24/7',
}: {
  agentName: string;
  /** Token endpoint: the landing dialer by default, or a workspace's test-call route. */
  endpoint?: string;
  tagline?: string;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const { status, error, muted, agentTalking, transcript, seconds, start, end, toggleMute } = useRetellCall({
    requestToken: () => fetchCallToken(endpoint, { pageUrl: window.location.href }),
  });

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  const badge =
    status === 'active'
      ? { text: `On Call • ${formatDuration(seconds)}`, cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' }
      : status === 'connecting'
        ? { text: 'Connecting…', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' }
        : { text: 'Ready', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' };

  return (
    <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl shadow-slate-200/70 ring-1 ring-slate-200">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${badge.cls}`}>
          {status === 'active' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
          {badge.text}
        </span>
        <span className="text-xs text-slate-400">Max 5 min</span>
      </div>

      <div className="mt-8 flex flex-col items-center">
        <div className="relative flex h-28 w-28 items-center justify-center">
          {agentTalking && (
            <>
              <span className="speak-ring absolute inset-0 rounded-full bg-indigo-400" />
              <span className="speak-ring absolute inset-0 rounded-full bg-indigo-300 [animation-delay:0.5s]" />
            </>
          )}
          <div
            className={`relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg transition-transform ${agentTalking ? 'scale-105' : ''}`}
          >
            <Headset className="h-12 w-12" strokeWidth={1.5} />
          </div>
        </div>
        <h2 className="mt-5 text-lg font-semibold text-slate-900">{agentName}</h2>
        <p className="text-sm text-slate-500">
          {status === 'active'
            ? agentTalking
              ? 'Speaking…'
              : muted
                ? 'Your mic is muted'
                : 'Listening…'
            : tagline}
        </p>
      </div>

      <div
        ref={transcriptRef}
        className="mt-6 h-48 space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-sm"
        aria-live="polite"
      >
        {transcript.length === 0 ? (
          <p className="flex h-full items-center justify-center text-center text-slate-400">
            {status === 'idle' ? 'Start a call and the conversation will appear here.' : 'Waiting for the conversation…'}
          </p>
        ) : (
          transcript.map((u, i) => (
            <div key={i} className={`flex ${u.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <p
                className={`max-w-[85%] rounded-2xl px-3 py-2 ${u.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
              >
                {u.content}
              </p>
            </div>
          ))
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-center gap-4">
        {status === 'idle' ? (
          <button
            onClick={start}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-6 py-3 font-medium text-white shadow-sm transition hover:bg-emerald-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
          >
            <Phone className="h-5 w-5" /> Start Call
          </button>
        ) : (
          <>
            <button
              onClick={toggleMute}
              disabled={status !== 'active'}
              aria-pressed={muted}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              className={`flex h-14 w-14 items-center justify-center rounded-full transition disabled:opacity-40 ${muted ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            >
              {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            </button>
            <button
              onClick={end}
              aria-label="End call"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition hover:bg-red-500"
            >
              <PhoneOff className="h-6 w-6" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
