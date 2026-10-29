import { Suspense } from 'react';
import { connection } from 'next/server';
import AgentSettingsForm, { type VoiceOption } from '@/components/admin/AgentSettingsForm';
import ProfileForm from '@/components/studio/ProfileForm';
import RulesEditor from '@/components/studio/RulesEditor';
import SetupChecklist from '@/components/workspace/SetupChecklist';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { configProfile, countPublishes, listRules, prepareDraft } from '@/lib/agent-draft';
import { countCalls } from '@/lib/call-logs';
import { listWidgets } from '@/lib/widgets';
import { errorMessage, getRetell } from '@/lib/retell';

async function loadVoices(): Promise<VoiceOption[]> {
  try {
    const voices = await getRetell().voice.list();
    return voices.map((v) => ({
      id: v.voice_id,
      name: v.voice_name,
      provider: v.provider,
      gender: v.gender,
      accent: v.accent,
    }));
  } catch (error) {
    console.error('[studio] failed to load voices', error);
    return [];
  }
}

async function Profile({ params }: { params: Promise<{ slug: string }> }) {
  // Request time only: this may provision Retell resources and must never run in a prefetch/prerender
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'admin');

  let data;
  try {
    const config = await prepareDraft(workspace);
    const [rules, voices, widgets, testCalls, publishes] = await Promise.all([
      listRules(workspace.id),
      loadVoices(),
      listWidgets(workspace.id),
      countCalls(workspace.id, 'test'),
      countPublishes(workspace.id),
    ]);
    data = { config, rules, voices, widgets, testCalls, publishes };
  } catch (error) {
    return <LoadError title="Couldn’t load the agent" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  const { config, rules, voices, widgets, testCalls, publishes } = data;
  const profile = configProfile(workspace, config);
  const base = `/w/${workspace.slug}`;
  const described =
    config.prompt_mode === 'advanced' || [profile.about, profile.services, profile.hours].some((f) => f.trim());
  const steps = [
    { label: 'Describe your business', detail: 'Services, prices, hours and policies.', done: described },
    { label: 'Add knowledge', detail: 'FAQs, web pages or files.', done: Boolean(config.retell_kb_id), href: `${base}/knowledge` },
    { label: 'Test your agent', detail: 'Chat with it or make a test call.', done: testCalls > 0, href: `${base}/test` },
    { label: 'Publish', detail: 'Callers hear the published version.', done: publishes > 0 },
    { label: 'Create a widget', detail: 'Pick its colors and button text.', done: widgets.length > 0, href: `${base}/widgets` },
    {
      label: 'Add it to your website',
      detail: 'Allow your site and paste one line of code.',
      done: widgets.some((w) => w.allowed_origins.length > 0),
      href: `${base}/widgets`,
    },
  ];

  return (
    <>
      <SetupChecklist steps={steps} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ProfileForm
          initialMode={config.prompt_mode}
          initialProfile={profile}
          initialCustomPrompt={config.custom_prompt ?? ''}
          agentName={config.agent_name}
          rules={rules.map((r) => r.rule)}
        />
        <div className="space-y-8">
          <AgentSettingsForm
            initial={{
              agent_name: config.agent_name,
              voice_id: config.voice_id,
              voice_speed: config.voice_speed,
              begin_message: config.begin_message,
            }}
            voices={voices}
            updatedAt={config.updated_at}
          />
          <RulesEditor initialRules={rules} />
        </div>
      </div>
    </>
  );
}

export default function ProfilePage({ params }: PageProps<'/w/[slug]'>) {
  return (
    <>
      <PageHeading title="Agent profile" description="Teach your agent about your business. Changes go to a draft until you publish." />
      <Suspense fallback={<Loading label="Loading your agent…" />}>
        <Profile params={params} />
      </Suspense>
    </>
  );
}
