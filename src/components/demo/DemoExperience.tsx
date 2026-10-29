'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Headset, Mic, MicOff, Phone, PhoneOff, Sparkles } from 'lucide-react';
import { formatDuration, useRetellCall, type CallToken } from '@/components/call/useRetellCall';
import {
  DEMO_LANGUAGES,
  DEMO_SCENARIOS,
  MIN_DEMO_CALL_SECONDS,
  type DemoLanguageId,
  type DemoScenarioId,
  type DemoStatus,
} from '@/lib/demo-config';

// Retell finalizes the call duration a moment after hang-up
const STATUS_REFRESH_DELAY_MS = 2000;

function clock(seconds: number) {
  const s = Math.max(Math.round(seconds), 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function DemoExperience({
  initialStatus,
  contactUrl,
  email,
  supportAgentName,
}: {
  initialStatus: DemoStatus;
  contactUrl: string | null;
  email: string;
  supportAgentName: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [scenario, setScenario] = useState<DemoScenarioId>('clinic');
  const [language, setLanguage] = useState<DemoLanguageId>('multi');
  const [allotted, setAllotted] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const res = await fetch('/api/demo/status');
    if (res.ok) setStatus((await res.json()).status);
  }, []);

  const call = useRetellCall({
    requestToken: async () => {
      const res = await fetch('/api/demo/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, language, pageUrl: window.location.href }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403 || res.status === 409) refreshStatus();
        throw new Error(data.error ?? 'Could not start the demo.');
      }
      setAllotted(data.allotted_seconds);
      return data as CallToken;
    },
    onEnded: () => setTimeout(refreshStatus, STATUS_REFRESH_DELAY_MS),
  });
  const { status: callStatus, error, muted, agentTalking, transcript, seconds } = call;
  const inCall = callStatus !== 'idle';

  // Retell can't cap a call under 1 minute, so a shorter allowance is ended here
  const overAllowance = callStatus === 'active' && allotted > 0 && seconds >= allotted;
  const endCall = call.end;
  useEffect(() => {
    if (overAllowance) endCall();
  }, [overAllowance, endCall]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  const timeLeft = callStatus === 'active' ? allotted - seconds : status.remainingSeconds;
  const usedUp = !inCall && status.remainingSeconds < MIN_DEMO_CALL_SECONDS;
  const meterShare = status.allowanceSeconds ? Math.max(timeLeft, 0) / status.allowanceSeconds : 0;
  const selected = DEMO_SCENARIOS.find((s) => s.id === scenario)!;
  const blocked = !status.enabled || status.budgetReached || usedUp;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
      {/* Scenarios */}
      <section>
        <h2 className="text-sm font-semibold text-slate-900">1. Pick a business</h2>
        <div role="radiogroup" aria-label="Demo scenario" className="mt-3 grid gap-3 sm:grid-cols-2">
          {DEMO_SCENARIOS.map((s) => {
            const active = s.id === scenario;
            return (
              <button
                key={s.id}
                role="radio"
                aria-checked={active}
                disabled={inCall}
                onClick={() => setScenario(s.id)}
                className={`rounded-2xl p-4 text-left transition disabled:cursor-not-allowed ${active ? 'bg-white shadow-sm ring-2 ring-indigo-600' : 'bg-white/60 ring-1 ring-slate-200 hover:bg-white disabled:opacity-60'}`}
              >
                <p className="font-medium text-slate-900">{s.id === 'support' ? supportAgentName : s.name}</p>
                <p className="mt-1 text-sm text-slate-500">{s.description}</p>
              </button>
            );
          })}
        </div>

        {scenario === 'support' ? (
          <p className="mt-6 text-sm text-slate-500">This is our live agent, so it uses its own language settings.</p>
        ) : (
          <div className="mt-6">
            <h2 id="language-heading" className="text-sm font-semibold text-slate-900">
              Language
            </h2>
            <div role="radiogroup" aria-labelledby="language-heading" className="mt-3 grid gap-3 sm:grid-cols-2">
              {DEMO_LANGUAGES.map((l) => {
                const active = l.id === language;
                return (
                  <button
                    key={l.id}
                    role="radio"
                    aria-checked={active}
                    disabled={inCall}
                    onClick={() => setLanguage(l.id)}
                    className={`rounded-2xl p-3 text-left transition disabled:cursor-not-allowed ${active ? 'bg-white shadow-sm ring-2 ring-indigo-600' : 'bg-white/60 ring-1 ring-slate-200 hover:bg-white disabled:opacity-60'}`}
                  >
                    <p className="text-sm font-medium text-slate-900">{l.label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{l.description}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-6 rounded-2xl bg-indigo-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
            <Sparkles className="h-4 w-4" /> 2. Try asking
          </p>
          <ul className="mt-2 space-y-1 text-sm text-indigo-800">
            {selected.tryAsking.map((q) => (
              <li key={q}>“{q}”</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-indigo-700">
            {scenario === 'support'
              ? 'Interrupt anytime, just like a real call.'
              : language === 'fil'
                ? 'Speak Filipino or Taglish. Interrupt anytime, just like a real call.'
                : 'Ask in any of 21 languages, e.g. “¿Cuánto cuesta una limpieza?” or “Je voudrais prendre rendez-vous.” The agent answers in yours.'}
          </p>
        </div>
      </section>

      {/* Call panel */}
      <section className="rounded-3xl bg-white p-6 shadow-xl shadow-slate-200/70 ring-1 ring-slate-200">
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-slate-700">Free time left</span>
            <span className="font-semibold tabular-nums text-slate-900">
              {clock(timeLeft)} <span className="font-normal text-slate-400">of {clock(status.allowanceSeconds)}</span>
            </span>
          </div>
          <div
            role="meter"
            aria-label="Free demo time left"
            aria-valuemin={0}
            aria-valuemax={status.allowanceSeconds}
            aria-valuenow={Math.max(Math.round(timeLeft), 0)}
            className="mt-2 h-2 rounded-full bg-indigo-100"
          >
            <div
              className={`h-2 rounded-full transition-[width] duration-1000 ${meterShare < 0.2 ? 'bg-amber-500' : 'bg-indigo-600'}`}
              style={{ width: `${meterShare * 100}%` }}
            />
          </div>
        </div>

        <div className="mt-6 flex flex-col items-center">
          <div className="relative flex h-24 w-24 items-center justify-center">
            {agentTalking && (
              <>
                <span className="speak-ring absolute inset-0 rounded-full bg-indigo-400" />
                <span className="speak-ring absolute inset-0 rounded-full bg-indigo-300 [animation-delay:0.5s]" />
              </>
            )}
            <div
              className={`relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg transition-transform ${agentTalking ? 'scale-105' : ''}`}
            >
              <Headset className="h-10 w-10" strokeWidth={1.5} />
            </div>
          </div>
          <p className="mt-4 font-semibold text-slate-900">{scenario === 'support' ? supportAgentName : selected.name}</p>
          <p className="text-sm text-slate-500">
            {callStatus === 'active'
              ? `${agentTalking ? 'Speaking…' : muted ? 'Your mic is muted' : 'Listening…'} · ${formatDuration(seconds)}`
              : callStatus === 'connecting'
                ? 'Connecting…'
                : 'Ready when you are'}
          </p>
        </div>

        <div
          ref={transcriptRef}
          className="mt-5 h-44 space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-sm"
          aria-live="polite"
        >
          {transcript.length === 0 ? (
            <p className="flex h-full items-center justify-center text-center text-slate-400">
              The conversation will appear here.
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

        <div className="mt-5">
          {inCall ? (
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={call.toggleMute}
                disabled={callStatus !== 'active'}
                aria-pressed={muted}
                aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                className={`flex h-14 w-14 items-center justify-center rounded-full transition disabled:opacity-40 ${muted ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
              </button>
              <button
                onClick={call.end}
                aria-label="End call"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition hover:bg-red-500"
              >
                <PhoneOff className="h-6 w-6" />
              </button>
            </div>
          ) : blocked ? (
            <BlockedNotice status={status} usedUp={usedUp} contactUrl={contactUrl} email={email} />
          ) : (
            <button
              onClick={call.start}
              disabled={status.inProgress}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-6 py-3 font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Phone className="h-5 w-5" /> Start demo call
            </button>
          )}
          {status.inProgress && !inCall && (
            <p className="mt-2 text-center text-xs text-slate-500">
              A demo call is still open in another tab. End it there, or wait a moment.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function BlockedNotice({
  status,
  usedUp,
  contactUrl,
  email,
}: {
  status: DemoStatus;
  usedUp: boolean;
  contactUrl: string | null;
  email: string;
}) {
  if (!status.enabled) {
    return <p className="rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-600">The demo is paused right now. Please check back soon.</p>;
  }
  if (usedUp) {
    return (
      <div className="rounded-2xl bg-indigo-50 p-4 text-center">
        <p className="font-semibold text-indigo-900">That’s your free demo time.</p>
        <p className="mt-1 text-sm text-indigo-800">
          Want an agent like this for your business, trained on your own documents?
        </p>
        {contactUrl ? (
          <a
            href={contactUrl}
            className="mt-3 inline-flex items-center justify-center rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Talk to us
          </a>
        ) : (
          <p className="mt-2 text-sm text-indigo-800">
            We’ll reach out to <span className="font-medium">{email}</span> shortly.
          </p>
        )}
      </div>
    );
  }
  return (
    <p className="rounded-xl bg-amber-50 p-4 text-center text-sm text-amber-800">
      Today’s demo calls are fully booked. Your {clock(status.remainingSeconds)} will still be here tomorrow.
    </p>
  );
}
