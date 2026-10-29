import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { Phone } from 'lucide-react';
import OutboundCalls from '@/components/admin/OutboundCalls';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { getOrProvisionAgentConfig } from '@/lib/agent-config';
import { listCallLogs } from '@/lib/call-logs';
import { outboundNumbers } from '@/lib/phone-numbers';
import { getBilling } from '@/lib/billing';
import { errorMessage } from '@/lib/retell';

function NeedsPlan({ slug }: { slug: string }) {
  return (
    <div className="flex gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
        <Phone className="h-5 w-5" />
      </span>
      <div>
        <h2 className="font-semibold text-slate-900">Outbound calls come with Growth and Business</h2>
        <p className="mt-1 max-w-xl text-sm text-slate-600">Your agent can call customers back, confirm bookings and follow up, from your own number.</p>
        <Link
          href={`/w/${slug}/billing`}
          className="mt-3 inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
        >
          See plans
        </Link>
      </div>
    </div>
  );
}

function NeedsNumber({ slug }: { slug: string }) {
  return (
    <div className="flex gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
        <Phone className="h-5 w-5" />
      </span>
      <div>
        <h2 className="font-semibold text-slate-900">Add a phone number first</h2>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Outbound calls come from one of this workspace’s numbers. Add a number, or turn on outbound calling for one you have.
        </p>
        <Link
          href={`/w/${slug}/numbers`}
          className="mt-3 inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
        >
          Phone numbers
        </Link>
      </div>
    </div>
  );
}

async function OutboundDashboard({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'admin', '/outbound');

  let data;
  try {
    data = await Promise.all([
      getOrProvisionAgentConfig(workspace),
      outboundNumbers(workspace.id),
      listCallLogs({ workspaceId: workspace.id, source: 'outbound' }),
      getBilling(workspace),
    ]);
  } catch (error) {
    return <LoadError title="Outbound calls are unavailable" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  const [config, numbers, calls, billing] = data;
  if (!billing.limits.outbound_allowed) return <NeedsPlan slug={slug} />;
  if (!numbers.length) return <NeedsNumber slug={slug} />;
  return (
    <OutboundCalls
      agentName={config.agent_name}
      numbers={numbers.map((n) => ({ number: n.e164, nickname: n.nickname }))}
      initialSettings={{
        retell_phone_number: config.retell_phone_number,
        outbound_begin_message: config.outbound_begin_message,
      }}
      initialCalls={calls}
    />
  );
}

export default function OutboundPage({ params }: PageProps<'/w/[slug]/outbound'>) {
  return (
    <>
      <PageHeading
        title="Outbound calls"
        description="Have the agent call a phone number, with the same voice, prompt and knowledge base."
      />
      <Suspense fallback={<Loading label="Loading outbound calls…" />}>
        <OutboundDashboard params={params} />
      </Suspense>
    </>
  );
}
