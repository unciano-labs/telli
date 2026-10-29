import 'server-only';
import Retell from 'retell-sdk';

const globalForRetell = globalThis as unknown as { retell?: Retell };

export function getRetell(): Retell {
  if (!globalForRetell.retell) {
    const apiKey = process.env.RETELL_API_KEY?.trim();
    if (!apiKey) throw new Error('Missing required environment variable: RETELL_API_KEY');
    globalForRetell.retell = new Retell({ apiKey });
  }
  return globalForRetell.retell;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'Unexpected error';
}
