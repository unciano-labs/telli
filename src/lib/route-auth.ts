import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeWorkspace, type WorkspaceAuthResult } from '@/lib/auth';
import { errorMessage } from '@/lib/retell';
import { BillingError } from '@/lib/billing';
import type { WorkspaceRole } from '@/lib/workspace-roles';

export type WorkspaceRouteAuth =
  | Extract<WorkspaceAuthResult, { ok: true }>
  | { ok: false; response: NextResponse };

/** For /api/w/[slug]/* handlers: the session user's access to the workspace, or the error response to return. */
export async function workspaceRoute(
  params: Promise<{ slug: string }>,
  minimum: WorkspaceRole
): Promise<WorkspaceRouteAuth> {
  const { slug } = await params;
  const auth = await authorizeWorkspace(slug, minimum);
  if (auth.ok) return auth;
  return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
}

/** Errors our libraries throw on purpose, with an HTTP status and a message safe to show. */
type AppError = Error & { status: number };

/**
 * Maps a thrown error to a JSON response: app errors (and plan limits) keep their status;
 * anything else is logged.
 */
export function errorResponse(error: unknown, label: string, appErrors: (new (...args: never[]) => AppError)[]) {
  if (error instanceof BillingError || appErrors.some((E) => error instanceof E)) {
    const { message, status } = error as AppError;
    return NextResponse.json({ error: message }, { status });
  }
  console.error(`[${label}]`, error);
  return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
}
