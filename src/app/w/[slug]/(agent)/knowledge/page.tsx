import { Suspense } from 'react';
import { connection } from 'next/server';
import DocumentManager from '@/components/admin/DocumentManager';
import FaqEditor from '@/components/studio/FaqEditor';
import WebPages from '@/components/studio/WebPages';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { listFaqs } from '@/lib/faqs';
import { getKbSummary, listDocuments } from '@/lib/knowledge-base';
import { errorMessage } from '@/lib/retell';

async function Knowledge({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace } = await requireWorkspacePage(slug, 'admin', '/knowledge');

  let data;
  try {
    const [faqs, summary, documents] = await Promise.all([
      listFaqs(workspace),
      getKbSummary(workspace),
      listDocuments(workspace),
    ]);
    data = { faqs, summary, documents };
  } catch (error) {
    return <LoadError title="Couldn’t load the knowledge base" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <FaqEditor initialFaqs={data.faqs} />
      <div className="space-y-8">
        <WebPages initial={data.summary} />
        <DocumentManager initialDocuments={data.documents} />
      </div>
    </div>
  );
}

export default function KnowledgePage({ params }: PageProps<'/w/[slug]/knowledge'>) {
  return (
    <>
      <PageHeading
        title="Knowledge"
        description="What your agent knows. FAQs, web pages and files apply to calls right away, no publish needed."
      />
      <Suspense fallback={<Loading label="Loading knowledge…" />}>
        <Knowledge params={params} />
      </Suspense>
    </>
  );
}
