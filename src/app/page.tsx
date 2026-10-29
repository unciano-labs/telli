import { Suspense } from 'react';
import { connection } from 'next/server';
import Link from 'next/link';
import { ArrowRight, BookOpen, Clock, ShieldCheck } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import Dialer from '@/components/Dialer';
import { findAgentConfig } from '@/lib/agent-config';
import { getPlatformWorkspace } from '@/lib/workspaces';

const FEATURES = [
  { icon: Clock, title: 'Instant answers', text: 'No hold music. The agent picks up right away, day or night.' },
  { icon: BookOpen, title: 'Knows our docs', text: 'Answers come from our up-to-date help articles and FAQs.' },
  { icon: ShieldCheck, title: 'Private by design', text: 'Calls run in your browser. Nothing to install.' },
];

async function AgentDialer() {
  await connection();
  const config = await getPlatformWorkspace()
    .then((ws) => findAgentConfig(ws.id))
    .catch(() => null);
  return <Dialer agentName={config?.agent_name ?? 'Customer Support'} />;
}

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[1fr_auto] lg:pt-12">
        <section>
          <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">24/7 voice support</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            Talk to support
            <br />
            in one click.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-slate-600">
            Press <span className="font-medium text-slate-900">Start Call</span>, allow your microphone, and ask
            anything. Our AI voice agent answers right away and can explain our products, policies and FAQs.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/demo"
              className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
            >
              Try it free for your business <ArrowRight className="h-4 w-4" />
            </Link>
            <span className="text-sm text-slate-500">Clinic, real estate and online store demos</span>
          </div>
          <ul className="mt-10 grid gap-6 sm:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title}>
                <Icon className="h-5 w-5 text-indigo-600" />
                <p className="mt-2 font-medium text-slate-900">{title}</p>
                <p className="mt-1 text-sm text-slate-500">{text}</p>
              </li>
            ))}
          </ul>
        </section>
        <div className="flex justify-center">
          <Suspense fallback={<Dialer agentName="Customer Support" />}>
            <AgentDialer />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
