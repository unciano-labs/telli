'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RetellWebClient } from 'retell-client-js-sdk';

export type CallStatus = 'idle' | 'connecting' | 'active';
export type Utterance = { role: 'agent' | 'user' | string; content: string };

/** Response of our call-token endpoints (/api/call/create, /api/widget/[key]/call). */
export type CallToken = {
  access_token: string;
  call_id: string;
  transport: string;
  ice_servers: unknown;
};

const MAX_TRANSCRIPT = 6;

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Browser voice call state for a Retell agent: mic check, token request, live
 * transcript, mute, timer, and cleanup on tab close/unmount.
 */
export function useRetellCall({
  requestToken,
  onStarted,
  onEnded,
}: {
  requestToken: () => Promise<CallToken>;
  onStarted?: () => void;
  onEnded?: () => void;
}) {
  const clientRef = useRef<RetellWebClient | null>(null);
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [agentTalking, setAgentTalking] = useState(false);
  const [transcript, setTranscript] = useState<Utterance[]>([]);
  const [seconds, setSeconds] = useState(0);
  /** The most recent call, and whether it connected (for feedback after it ends). */
  const [lastCall, setLastCall] = useState<{ id: string; connected: boolean } | null>(null);

  // Latest callbacks without re-registering SDK listeners
  const callbacks = useRef({ onStarted, onEnded });
  useEffect(() => {
    callbacks.current = { onStarted, onEnded };
  }, [onStarted, onEnded]);

  const resetCall = useCallback(() => {
    setStatus('idle');
    setMuted(false);
    setAgentTalking(false);
  }, []);

  const getClient = useCallback(async () => {
    if (clientRef.current) return clientRef.current;
    // Loaded on demand: the SDK touches browser-only APIs
    const { RetellWebClient } = await import('retell-client-js-sdk');
    const client = new RetellWebClient();

    client.on('call_started', () => {
      setStatus('active');
      setSeconds(0);
      setLastCall((c) => c && { ...c, connected: true });
      callbacks.current.onStarted?.();
    });
    client.on('call_ended', () => {
      resetCall();
      callbacks.current.onEnded?.();
    });
    client.on('agent_start_talking', () => setAgentTalking(true));
    client.on('agent_stop_talking', () => setAgentTalking(false));
    client.on('update', (event: { transcript?: Utterance[] }) => {
      if (event.transcript) {
        setTranscript(event.transcript.filter((u) => u.content?.trim()).slice(-MAX_TRANSCRIPT));
      }
    });
    client.on('error', (err: unknown) => {
      console.error('Retell call error', err);
      setError('The call was interrupted. Please try again.');
      client.stopCall();
      resetCall();
    });

    clientRef.current = client;
    return client;
  }, [resetCall]);

  // Call timer
  useEffect(() => {
    if (status !== 'active') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  // Stop the call when the tab closes or the component unmounts
  useEffect(() => {
    const stop = () => clientRef.current?.stopCall();
    window.addEventListener('beforeunload', stop);
    return () => {
      window.removeEventListener('beforeunload', stop);
      stop();
    };
  }, []);

  async function start() {
    setError(null);
    setTranscript([]);
    setLastCall(null);
    setStatus('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      setError(
        denied
          ? 'Microphone access was blocked. Allow microphone access in your browser settings, then try again.'
          : 'No microphone was found. Connect a microphone and try again.'
      );
      setStatus('idle');
      return;
    }

    try {
      const token = await requestToken();
      setLastCall({ id: token.call_id, connected: false });
      const client = await getClient();
      await client.startCall({
        accessToken: token.access_token,
        callId: token.call_id,
        transport: token.transport,
        iceServers: token.ice_servers,
        sampleRate: 24000,
        emitRawAudioSamples: false,
      } as Parameters<RetellWebClient['startCall']>[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the call.');
      resetCall();
    }
  }

  const end = useCallback(() => {
    clientRef.current?.stopCall();
    resetCall();
  }, [resetCall]);

  function toggleMute() {
    const client = clientRef.current;
    if (!client) return;
    if (muted) client.unmute();
    else client.mute();
    setMuted(!muted);
  }

  return { status, error, muted, agentTalking, transcript, seconds, lastCall, start, end, toggleMute };
}

/** POSTs JSON to a call-token endpoint and surfaces the server's error message. */
export async function fetchCallToken(url: string, body: Record<string, unknown> = {}): Promise<CallToken> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Could not start the call.');
  return data as CallToken;
}
