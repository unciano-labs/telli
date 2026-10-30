import Link from 'next/link';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { Clock, Languages, ShieldCheck } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import DemoExperience from '@/components/demo/DemoExperience';
import { createClient } from '@/lib/supabase/server';
import { hasWebsiteAccess } from '@/lib/auth';
import { findAgentConfig } from '@/lib/agent-config';
import { getPlatformWorkspace } from '@/lib/workspaces';
import { getDemoSettings, getDemoStatus, liveScenarioNames } from '@/lib/demo';
import { errorMessage } from '@/lib/retell';

export const metadata: Metadata = {
  title: 'Try the AI voice agent free',
  description: 'Talk to an AI voice agent for a clinic, a real estate office or an online store. Free minutes, no card.',
};

function SignupPrompt({ minutes }: { minutes: number }) {
  return (
    <div className="mx-auto max-w-xl rounded-3xl bg-white p-8 text-center shadow-xl shadow-slate-200/70 ring-1 ring-slate-200">
      <h2 className="text-xl font-semibold text-slate-900">Create a free account to start talking</h2>
      <p className="mt-2 text-slate-600">
        You get <span className="font-semibold text-slate-900">{minutes} free minutes</span> of live calls. No card
        needed.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
        <Link
          href="/signup?next=/demo"
          className="rounded-full bg-indigo-600 px-6 py-3 font-semibold text-white shadow-sm hover:bg-indigo-500"
        >
          Sign up free
        </Link>
        <Link
          href="/login?next=/demo"
          className="rounded-full px-6 py-3 font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
        >
          I have an account
        </Link>
      </div>
    </div>
  );
}

async function DemoGate() {
  await connection();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let settings;
  try {
    settings = await getDemoSettings();
  } catch (error) {
    console.error('[demo] settings', errorMessage(error));
  }
  const minutes = Math.round((settings?.seconds_per_user ?? 300) / 60);

  if (!user || !(await hasWebsiteAccess(user.id))) return <SignupPrompt minutes={minutes} />;

  let loaded;
  try {
    const [status, config, liveNames] = await Promise.all([
      getDemoStatus(user.id),
      getPlatformWorkspace().then((ws) => findAgentConfig(ws.id)),
      liveScenarioNames(settings ?? null),
    ]);
    loaded = { status, agentName: config?.agent_name ?? 'Customer Support', liveNames };
  } catch (error) {
    console.error('[demo] status', errorMessage(error));
    return (
      <p className="rounded-2xl bg-red-50 p-5 text-sm text-red-800 ring-1 ring-red-200">
        The demo couldn’t load. Please refresh the page in a moment.
      </p>
    );
  }

  return (
    <DemoExperience
      initialStatus={loaded.status}
      contactUrl={settings?.contact_url ?? null}
      email={user.email ?? ''}
      supportAgentName={loaded.agentName}
      liveNames={loaded.liveNames}
    />
  );
}

const POINTS = [
  { icon: Clock, text: 'Answers instantly, 24/7' },
  { icon: Languages, text: 'English, Filipino and Taglish' },
  { icon: ShieldCheck, text: 'Runs in your browser, nothing to install' },
];

export default function DemoPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-6 sm:px-6">
        <div className="mb-10 max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Live demo</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Talk to an AI voice agent, free.
          </h1>
          <p className="mt-3 text-lg text-slate-600">
            Pick a business, press start, and call it from your browser. Ask the questions your own customers would.
          </p>
          <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-indigo-600" /> {text}
              </li>
            ))}
          </ul>
        </div>
        <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-slate-100" />}>
          <DemoGate />
        </Suspense>
      </main>
    </div>
  );
}
