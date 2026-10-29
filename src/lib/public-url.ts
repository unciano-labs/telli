// The deployment's public https address (PUBLIC_APP_URL), or null when outside services like
// Retell can't reach it (unset, http, localhost). Webhooks and agent functions need it.

export function publicAppUrl(): string | null {
  const base = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}
