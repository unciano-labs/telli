import 'server-only';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Tenant identifier for this deployment in the shared Supabase project. */
export const WEBSITE_ID = required('WEBSITE_ID');
