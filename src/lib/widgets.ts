import 'server-only';
import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import { normalizeOrigin, WIDGET_DEFAULTS } from '@/lib/widget-config';

export type Widget = {
  id: string;
  website_id: string;
  workspace_id: string;
  public_key: string;
  name: string;
  allowed_origins: string[];
  title: string;
  button_label: string;
  accent_color: string;
  position: 'right' | 'left';
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type WidgetUpdate = Partial<
  Pick<Widget, 'name' | 'allowed_origins' | 'title' | 'button_label' | 'accent_color' | 'position' | 'enabled'>
>;

export class WidgetError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const KEY_PATTERN = /^wk_[A-Za-z0-9_-]{16}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_ORIGINS = 20;

function db() {
  return createAdminClient();
}

export function isWidgetKey(key: string) {
  return KEY_PATTERN.test(key);
}

/** True if `origin` is allowed by the list (exact match, or a `https://*.example.com` wildcard). */
export function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((rule) => {
    if (rule === origin) return true;
    const wildcard = /^(https?):\/\/\*\.(.+)$/.exec(rule);
    if (!wildcard) return false;
    const [, scheme, suffix] = wildcard;
    return origin.startsWith(`${scheme}://`) && origin.endsWith(`.${suffix}`);
  });
}

export async function listWidgets(workspaceId: string): Promise<Widget[]> {
  const { data, error } = await db()
    .from('va_widgets')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load widgets: ${error.message}`);
  return data as Widget[];
}

/** Public lookup by embed key (any workspace). Returns null for unknown keys. */
export async function findWidgetByKey(key: string): Promise<Widget | null> {
  if (!isWidgetKey(key)) return null;
  const { data, error } = await db()
    .from('va_widgets')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('public_key', key)
    .maybeSingle();
  if (error) throw new Error(`Failed to load widget: ${error.message}`);
  return (data as Widget) ?? null;
}

// The proxy checks frame-ancestors on every embed load; cache briefly per server instance
const ANCESTOR_TTL_MS = 30_000;
const ancestorCache = new Map<string, { origins: string[]; expires: number }>();

/** Origins allowed to frame this widget. Empty if the widget is unknown or disabled. */
export async function getFrameAncestors(key: string): Promise<string[]> {
  const cached = ancestorCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.origins;

  let origins: string[] = [];
  try {
    const widget = await findWidgetByKey(key);
    origins = widget?.enabled ? widget.allowed_origins : [];
  } catch (error) {
    console.error('[widgets] frame-ancestors lookup failed', error);
  }
  if (ancestorCache.size > 1000) ancestorCache.clear();
  ancestorCache.set(key, { origins, expires: Date.now() + ANCESTOR_TTL_MS });
  return origins;
}

export async function createWidget(workspaceId: string, name: string): Promise<Widget> {
  const { data, error } = await db()
    .from('va_widgets')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspaceId,
      public_key: `wk_${randomBytes(12).toString('base64url')}`,
      name,
      ...WIDGET_DEFAULTS,
    })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to create widget: ${error.message}`);
  return data as Widget;
}

/** Validates and normalizes an update. Throws WidgetError (400) on bad input. */
export function validateWidgetUpdate(body: Record<string, unknown>): WidgetUpdate {
  const update: WidgetUpdate = {};
  const text = (key: string, max: number) => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw new WidgetError(`${key.replaceAll('_', ' ')} is required (max ${max} characters)`, 400);
    }
    return value.trim();
  };

  update.name = text('name', 80);
  update.title = text('title', 60);
  update.button_label = text('button_label', 30);

  if (body.accent_color !== undefined) {
    if (typeof body.accent_color !== 'string' || !COLOR_PATTERN.test(body.accent_color)) {
      throw new WidgetError('Accent color must be a hex color like #4f46e5', 400);
    }
    update.accent_color = body.accent_color.toLowerCase();
  }
  if (body.position !== undefined) {
    if (body.position !== 'right' && body.position !== 'left') {
      throw new WidgetError('Position must be "right" or "left"', 400);
    }
    update.position = body.position;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new WidgetError('enabled must be true or false', 400);
    update.enabled = body.enabled;
  }
  if (body.allowed_origins !== undefined) {
    if (!Array.isArray(body.allowed_origins)) throw new WidgetError('allowed_origins must be a list', 400);
    const entries = body.allowed_origins.filter((o): o is string => typeof o === 'string' && o.trim() !== '');
    const invalid: string[] = [];
    const origins = new Set<string>();
    for (const entry of entries) {
      const origin = normalizeOrigin(entry);
      if (origin) origins.add(origin);
      else invalid.push(entry);
    }
    if (invalid.length) throw new WidgetError(`Not a valid website address: ${invalid.join(', ')}`, 400);
    if (origins.size > MAX_ORIGINS) throw new WidgetError(`At most ${MAX_ORIGINS} websites per widget`, 400);
    update.allowed_origins = [...origins];
  }

  return Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) as WidgetUpdate;
}

export async function updateWidget(workspaceId: string, id: string, update: WidgetUpdate): Promise<Widget> {
  const { data, error } = await db()
    .from('va_widgets')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Failed to update widget: ${error.message}`);
  if (!data) throw new WidgetError('Widget not found', 404);
  ancestorCache.delete((data as Widget).public_key);
  return data as Widget;
}

export async function deleteWidget(workspaceId: string, id: string): Promise<void> {
  const { data, error } = await db()
    .from('va_widgets')
    .delete()
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select('public_key')
    .maybeSingle();
  if (error) throw new Error(`Failed to delete widget: ${error.message}`);
  if (!data) throw new WidgetError('Widget not found', 404);
  ancestorCache.delete(data.public_key);
}

export type WidgetEvent = 'loaded' | 'opened' | 'call_started' | 'call_ended';
export const WIDGET_EVENTS: readonly WidgetEvent[] = ['loaded', 'opened', 'call_started', 'call_ended'];

export async function recordWidgetEvent(
  widget: Widget,
  event: WidgetEvent,
  visitorId: string | null,
  pageUrl: string | null
) {
  const { error } = await db().from('va_widget_events').insert({
    website_id: WEBSITE_ID,
    workspace_id: widget.workspace_id,
    widget_id: widget.id,
    event,
    visitor_id: visitorId,
    page_url: pageUrl,
  });
  if (error) throw new Error(`Failed to record widget event: ${error.message}`);
}
