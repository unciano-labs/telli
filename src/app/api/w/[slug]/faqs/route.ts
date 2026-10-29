import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { KbError } from '@/lib/knowledge-base';
import { createFaq, deleteFaq, listFaqs, updateFaq, validateFaq } from '@/lib/faqs';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idFrom(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  return UUID.test(id) ? id : null;
}

export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ faqs: await listFaqs(auth.workspace) });
  } catch (error) {
    return errorResponse(error, 'w/faqs GET', [KbError]);
  }
}

/** Body: { question, alternates[], answer }. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    const faq = await createFaq(auth.workspace, auth.user.id, validateFaq(body));
    return NextResponse.json({ faq }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/faqs POST', [KbError]);
  }
}

/** Query: ?id=… Body: { question, alternates[], answer }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid FAQ id is required' }, { status: 400 });
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    const faq = await updateFaq(auth.workspace, auth.user.id, id, validateFaq(body));
    return NextResponse.json({ faq });
  } catch (error) {
    return errorResponse(error, 'w/faqs PATCH', [KbError]);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid FAQ id is required' }, { status: 400 });
  try {
    await deleteFaq(auth.workspace, auth.user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'w/faqs DELETE', [KbError]);
  }
}
