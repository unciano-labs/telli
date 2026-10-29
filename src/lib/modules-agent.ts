import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { publicAppUrl } from '@/lib/public-url';
import { defaultSettings, type ModuleId, type ModuleState } from '@/lib/modules-shared';

// What a module adds to the agent: Retell custom functions that call /api/agent-tools, and a
// prompt section with today's date and how to use them. Both live in the draft (they're part
// of the LLM version), so enabling a module goes live on Publish; the data behind the
// functions (services, apartments, bookings) is live at once.

export const AGENT_TOOLS_PATH = '/api/agent-tools';

const MODULE_TOOL_NAMES: Record<ModuleId, string[]> = {
  reservations: ['get_services', 'check_availability', 'book_appointment'],
  rentals: ['get_apartments', 'check_stay_availability', 'book_stay'],
};
/** Tools this app manages on a workspace LLM (replaced on every draft save). */
export const MANAGED_TOOL_NAMES = new Set(['end_call', ...Object.values(MODULE_TOOL_NAMES).flat()]);

export async function getModuleStates(workspaceId: string): Promise<ModuleState[]> {
  const { data, error } = await createAdminClient()
    .from('va_workspace_modules')
    .select('module, enabled, settings')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`Failed to load modules: ${error.message}`);
  return (data as { module: ModuleId; enabled: boolean; settings: Record<string, unknown> }[]).map((row) => ({
    module: row.module,
    enabled: row.enabled,
    // Missing keys (older rows) fall back to the defaults
    settings: { ...defaultSettings(row.module), ...row.settings },
  })) as ModuleState[];
}

export async function enabledModules(workspaceId: string): Promise<ModuleState[]> {
  return (await getModuleStates(workspaceId)).filter((m) => m.enabled);
}

const string = (description: string) => ({ type: 'string', description });

function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'custom' as const,
    name,
    description,
    url: `${publicAppUrl()}${AGENT_TOOLS_PATH}`,
    method: 'POST' as const,
    parameters: { type: 'object' as const, properties, required },
    speak_during_execution: true,
    execution_message_description: 'Tell the caller in a few words that you are checking.',
    speak_after_execution: true,
    timeout_ms: 10_000,
  };
}

/** The Retell custom functions for the enabled modules. None without a public URL to call. */
export function moduleTools(modules: ModuleState[]) {
  if (!publicAppUrl()) return [];
  const tools = [];
  for (const { module } of modules) {
    if (module === 'reservations') {
      tools.push(
        tool('get_services', 'List the services the business offers, with how long each takes and its price.'),
        tool(
          'check_availability',
          'Find the free start times for a service on one date. Always call this before offering or confirming a time.',
          { service: string('The service name, as listed by get_services'), date: string('The date, YYYY-MM-DD') },
          ['service', 'date']
        ),
        tool(
          'book_appointment',
          'Book an appointment after the caller confirmed the service, date, time, their name and mobile number.',
          {
            service: string('The service name'),
            date: string('YYYY-MM-DD'),
            time: string('Start time, HH:MM in 24-hour time, one of the times check_availability returned'),
            customer_name: string('The caller’s full name'),
            customer_phone: string('The caller’s mobile number'),
            notes: string('Anything the business should know (optional)'),
          },
          ['service', 'date', 'time', 'customer_name', 'customer_phone']
        )
      );
    } else {
      tools.push(
        tool('get_apartments', 'List the apartments: price per night, address, guests, bedrooms, amenities and house rules.'),
        tool(
          'check_stay_availability',
          'Find which apartments are free for a stay, with the total price. Always call this before quoting or confirming dates.',
          {
            check_in: string('Check-in date, YYYY-MM-DD'),
            check_out: string('Check-out date, YYYY-MM-DD'),
            guests: { type: 'integer', description: 'Number of guests' },
            apartment: string('A specific apartment name, if the caller asked for one (optional)'),
          },
          ['check_in', 'check_out', 'guests']
        ),
        tool(
          'book_stay',
          'Book a stay after the caller confirmed the apartment, dates, number of guests, their name and mobile number.',
          {
            apartment: string('The apartment name'),
            check_in: string('YYYY-MM-DD'),
            check_out: string('YYYY-MM-DD'),
            guests: { type: 'integer', description: 'Number of guests' },
            customer_name: string('The guest’s full name'),
            customer_phone: string('The guest’s mobile number'),
            notes: string('Arrival time or requests (optional)'),
          },
          ['apartment', 'check_in', 'check_out', 'guests', 'customer_name', 'customer_phone']
        )
      );
    }
  }
  return tools;
}

/** Prompt section for the enabled modules: today's date in the business's time zone and booking rules. */
export function modulesPrompt(modules: ModuleState[]): string {
  if (!modules.length) return '';
  const timezone = modules[0].settings.timezone;
  const lines = [
    '## Bookings',
    `Today is {{current_time_${timezone}}}. The next two weeks:\n{{current_calendar_${timezone}}}`,
    '- Work out exact dates from what the caller says ("next Friday", "this weekend") using the calendar above, and pass dates to functions as YYYY-MM-DD.',
    '- Never say something is available, or quote a total, without checking with a function first. Don’t invent services, apartments, prices or times.',
    '- Offer at most three options at a time.',
    '- Before booking, read back the details (what, when, name, mobile number) and wait for a clear yes.',
    '- After booking, confirm it in one sentence. If a function says something is no longer free, offer the alternatives it gives.',
  ];
  if (!publicAppUrl()) {
    lines.push('- Booking functions aren’t connected yet. Take the caller’s details and preferred time, and say the team will confirm by text.');
  }
  return lines.join('\n');
}
