import { NextResponse } from 'next/server';
import { authorizeMember } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { getDemoStatus } from '@/lib/demo';

export async function GET() {
  const auth = await authorizeMember();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    return NextResponse.json({ status: await getDemoStatus(auth.user.id) });
  } catch (error) {
    console.error('[demo/status]', errorMessage(error));
    return NextResponse.json({ error: 'Could not load your demo time.' }, { status: 500 });
  }
}
