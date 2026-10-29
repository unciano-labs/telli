import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { startTestRun, TestError } from '@/lib/agent-tests';

const MAX_RUNS = 10;
const WINDOW_MS = 60 * 60 * 1000;

/** Runs every test case against the draft. Poll GET ../tests for results. */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'admin');
  if (!auth.ok) return auth.response;
  if (!rateLimit(`test-run:${auth.workspace.id}`, MAX_RUNS, WINDOW_MS).allowed) {
    return NextResponse.json({ error: 'Too many test runs. Try again later.' }, { status: 429 });
  }
  try {
    return NextResponse.json({ run: await startTestRun(auth.workspace, auth.user.id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'w/tests/run', [TestError]);
  }
}
