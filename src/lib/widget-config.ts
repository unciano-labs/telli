// Shared by client and server: widget defaults and input normalization

export const WIDGET_DEFAULTS = {
  allowed_origins: [] as string[],
  title: 'Voice support',
  button_label: 'Talk to us',
  accent_color: '#4f46e5',
  position: 'right' as 'right' | 'left',
};

/**
 * Normalizes a website address to a CSP-safe origin: "example.com/pricing" -> "https://example.com".
 * Allows a leading subdomain wildcard ("https://*.example.com"). Returns null if invalid.
 */
export function normalizeOrigin(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (!/^https?:\/\//.test(value)) value = `https://${value}`;

  const wildcard = value.includes('://*.');
  try {
    const url = new URL(wildcard ? value.replace('://*.', '://wildcard.') : value);
    if (url.username || url.password) return null;
    const host = wildcard ? url.host.replace(/^wildcard\./, '*.') : url.host;
    // Hostname chars only: keeps the value safe to put in a CSP header
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(host)) return null;
    return `${url.protocol}//${host}`;
  } catch {
    return null;
  }
}

/** Keeps origin + path only: query strings and fragments can carry personal data. */
export function normalizePageUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

export function normalizeVisitorId(input: unknown): string | null {
  return typeof input === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input) ? input : null;
}

export function embedSnippet(appOrigin: string, publicKey: string) {
  return `<script src="${appOrigin}/widget.js" data-key="${publicKey}" async></script>`;
}
