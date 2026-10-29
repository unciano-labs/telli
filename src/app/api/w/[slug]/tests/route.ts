import { NextResponse } from 'next/server';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import {
  createTestCase,
  deleteTestCase,
  latestTestRun,
  listTestCases,
  TestError,
  updateTestCase,
  validateTestCase,
} from '@/lib/agent-tests';

type Params = { params: Promise<{ slug: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idFrom(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  return UUID.test(id) ? id : null;
}

/** Test cases and the latest run (refreshed while running). Members can view. */
export async function GET(_req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  try {
    const [cases, run] = await Promise.all([listTestCases(auth.workspace), latestTestRun(auth.workspace)]);
    return NextResponse.json({ cases, run });
  } catch (error) {
    return errorResponse(error, 'w/tests GET', [TestError]);
  }
}

/** Body: { name, caller, expectation }. */
export async function POST(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    const testCase = await createTestCase(auth.workspace, auth.user.id, validateTestCase(body));
    return NextResponse.json({ testCase }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/tests POST', [TestError]);
  }
}

/** Query: ?id=… Body: { name, caller, expectation }. */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid test case id is required' }, { status: 400 });
  const body = (await req.json().catch(() => null)) ?? {};
  try {
    return NextResponse.json({ testCase: await updateTestCase(auth.workspace, id, validateTestCase(body)) });
  } catch (error) {
    return errorResponse(error, 'w/tests PATCH', [TestError]);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  const id = idFrom(req);
  if (!id) return NextResponse.json({ error: 'A valid test case id is required' }, { status: 400 });
  try {
    await deleteTestCase(auth.workspace, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 'w/tests DELETE', [TestError]);
  }
}
