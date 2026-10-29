// Shared by client and server: knowledge base upload rules
export const ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.md', '.docx'] as const;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const MAX_CALL_DURATION_MS = 300_000; // 5 minutes
// Retell rejects a max_call_duration_ms under 1 minute
export const RETELL_MIN_CALL_MS = 60_000;
export const MIN_VOICE_SPEED = 0.5;
export const MAX_VOICE_SPEED = 2.0;

export const KB_BUCKET = 'knowledge-docs';

export function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

// Countries the outbound caller can dial. Each number narrows it (va_phone_numbers.outbound_countries).
export const OUTBOUND_COUNTRIES = [
  { prefix: '+63', name: 'Philippines' },
  { prefix: '+1', name: 'United States' },
] as const;

/**
 * Normalizes to E.164. Accepts "+639171234567", "639171234567" and PH local
 * "09171234567". Returns null if the number isn't valid or the country isn't allowed.
 */
export function normalizePhoneNumber(input: string): string | null {
  let n = input.replace(/[\s().-]/g, '');
  if (/^09\d{9}$/.test(n)) n = `+63${n.slice(1)}`;
  else if (/^63\d{10}$/.test(n)) n = `+${n}`;
  if (!/^\+[1-9]\d{7,14}$/.test(n)) return null;
  if (n.startsWith('+63') && n.length !== 13) return null;
  if (n.startsWith('+1') && n.length !== 12) return null;
  return OUTBOUND_COUNTRIES.some((c) => n.startsWith(c.prefix)) ? n : null;
}

/** Fills {{customer_name}}, {{reason}}, {{agent_name}} in the outbound greeting template. */
export function renderGreeting(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key]?.trim() || '')
    .replace(/\s+([,.?!])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Returns an error message, or null when the file is acceptable. */
export function validateKbFile(fileName: string, fileSize: number): string | null {
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(getExtension(fileName))) {
    return `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return 'File is empty';
  }
  if (fileSize > MAX_FILE_SIZE) {
    return 'File exceeds the 10 MB limit';
  }
  return null;
}
