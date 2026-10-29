import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { errorResponse, workspaceRoute } from '@/lib/route-auth';
import { playgroundReply, TestError, type PlaygroundMessage } from '@/lib/agent-tests';

const MAX_REPLIES = 60;
const WINDOW_MS = 10 * 60 * 1000;

/** Body: { version: "draft" | "live", messages: [{ role, content }] }. Members can test. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await workspaceRoute(params, 'member');
  if (!auth.ok) return auth.response;
  if (!rateLimit(`playground:${auth.user.id}`, MAX_REPLIES, WINDOW_MS).allowed) {
    return NextResponse.json({ error: 'Too many messages. Try again in a few minutes.' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const version = body?.version === 'live' ? 'live' : 'draft';
  const messages: PlaygroundMessage[] = Array.isArray(body?.messages)
    ? body.messages
        .filter((m: unknown): m is PlaygroundMessage => {
          const msg = m as PlaygroundMessage;
          return (msg?.role === 'agent' || msg?.role === 'user') && typeof msg.content === 'string';
        })
        .map((m: PlaygroundMessage) => ({ role: m.role, content: m.content.slice(0, 1000) }))
    : [];

  try {
    return NextResponse.json({ replies: await playgroundReply(auth.workspace, version, messages) });
  } catch (error) {
    return errorResponse(error, 'w/playground', [TestError]);
  }
}
