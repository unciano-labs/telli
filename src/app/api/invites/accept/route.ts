import { NextResponse } from 'next/server';
import { authorizeMember } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { rateLimit } from '@/lib/rate-limit';
import { acceptInvite, TeamError } from '@/lib/team';

const MAX_TRIES = 10;
const WINDOW_MS = 10 * 60 * 1000;

/** Body: { token }. Joins the workspace the invite is for; returns its slug. */
export async function POST(req: Request) {
  const auth = await authorizeMember();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!rateLimit(`invite-accept:${auth.user.id}`, MAX_TRIES, WINDOW_MS).allowed) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';

  try {
    const slug = await acceptInvite(token, auth.user);
    return NextResponse.json({ slug });
  } catch (error) {
    if (error instanceof TeamError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[invites/accept]', error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
