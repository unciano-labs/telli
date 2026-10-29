import type { Metadata } from 'next';
import { Suspense } from 'react';
import { connection } from 'next/server';
import WidgetApp, { WidgetUnavailable } from '@/components/widget/WidgetApp';
import { findWidgetByKey } from '@/lib/widgets';
import { findAgentConfig } from '@/lib/agent-config';
import { normalizePageUrl } from '@/lib/widget-config';
import { findWorkspaceById } from '@/lib/workspaces';

export const metadata: Metadata = {
  title: 'Voice support',
  robots: { index: false, follow: false },
};

async function Embed({ params, searchParams }: PageProps<'/embed/[key]'>) {
  await connection();
  const [{ key }, query] = await Promise.all([params, searchParams]);

  const widget = await findWidgetByKey(key).catch((error) => {
    console.error('[embed] widget lookup failed', error);
    return null;
  });
  if (!widget || !widget.enabled) return <WidgetUnavailable />;
  const [workspace, config] = await Promise.all([
    findWorkspaceById(widget.workspace_id).catch(() => null),
    findAgentConfig(widget.workspace_id).catch(() => null),
  ]);
  if (!workspace || workspace.status === 'suspended' || !config) return <WidgetUnavailable />;

  return (
    <WidgetApp
      widgetKey={widget.public_key}
      agentName={config.agent_name}
      title={widget.title}
      buttonLabel={widget.button_label}
      accentColor={widget.accent_color}
      position={widget.position}
      preview={query.preview === '1'}
      pageUrl={normalizePageUrl(query.page)}
    />
  );
}

/** Rendered inside the iframe that public/widget.js injects into customer sites. */
export default function EmbedPage(props: PageProps<'/embed/[key]'>) {
  return (
    <>
      {/* Transparent so only the launcher/panel shows over the host page */}
      <style>{'html,body{background:transparent!important;color-scheme:light}'}</style>
      <Suspense fallback={null}>
        <Embed {...props} />
      </Suspense>
    </>
  );
}
