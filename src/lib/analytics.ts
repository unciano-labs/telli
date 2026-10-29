import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { WEBSITE_ID } from '@/lib/env';
import type { CallSource } from '@/lib/call-logs';

/** Days are bucketed in this timezone (most customers are in the Philippines). */
export const ANALYTICS_TZ = process.env.ANALYTICS_TIMEZONE?.trim() || 'Asia/Manila';
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_PAGES = 5;

export type Analytics = {
  days: Range;
  timezone: string;
  totals: { calls: number; connected: number; seconds: number; costCents: number };
  daily: { day: string; calls: number; seconds: number }[];
  bySource: { source: CallSource; calls: number; seconds: number }[];
  /** Unique visitors per widget step. */
  funnel: { loaded: number; opened: number; callStarted: number };
  topPages: { page: string; calls: number; seconds: number }[];
};

type UsageRow = {
  day: string;
  source: CallSource;
  calls: number;
  connected: number;
  seconds: number;
  cost_cents: number | string;
};

export function dayKey(date: Date) {
  // en-CA formats as YYYY-MM-DD, matching Postgres ::date
  return new Intl.DateTimeFormat('en-CA', { timeZone: ANALYTICS_TZ }).format(date);
}

export function parseRange(value: unknown): Range {
  const n = Number(value);
  return (RANGES as readonly number[]).includes(n) ? (n as Range) : 30;
}

/** Usage for the last `days` days (today included). Admin test calls are excluded. */
export async function getAnalytics({
  workspaceId,
  days,
  widgetId,
}: {
  workspaceId: string;
  days: Range;
  widgetId?: string;
}): Promise<Analytics> {
  const db = createAdminClient();
  const now = Date.now();
  const dayList = Array.from({ length: days }, (_, i) => dayKey(new Date(now - (days - 1 - i) * DAY_MS)));
  const inRange = new Set(dayList);
  const since = new Date(now - days * DAY_MS).toISOString();

  let pagesQuery = db
    .from('va_call_logs')
    .select('page_url, duration_ms')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspaceId)
    .eq('source', 'widget')
    .not('page_url', 'is', null)
    .gte('created_at', since)
    .limit(5000);
  if (widgetId) pagesQuery = pagesQuery.eq('widget_id', widgetId);

  const [usage, funnel, pages] = await Promise.all([
    db.rpc('va_usage_daily', {
      p_website_id: WEBSITE_ID,
      p_workspace_id: workspaceId,
      p_since: since,
      p_tz: ANALYTICS_TZ,
      p_widget_id: widgetId ?? null,
    }),
    db.rpc('va_widget_funnel', {
      p_website_id: WEBSITE_ID,
      p_workspace_id: workspaceId,
      p_since: since,
      p_widget_id: widgetId ?? null,
    }),
    pagesQuery,
  ]);
  if (usage.error) throw new Error(`Failed to load usage: ${usage.error.message}`);
  if (funnel.error) throw new Error(`Failed to load widget funnel: ${funnel.error.message}`);
  if (pages.error) throw new Error(`Failed to load top pages: ${pages.error.message}`);

  const rows = (usage.data as UsageRow[]).filter((r) => r.source !== 'test' && inRange.has(r.day));

  const totals = { calls: 0, connected: 0, seconds: 0, costCents: 0 };
  const daily = new Map(dayList.map((day) => [day, { day, calls: 0, seconds: 0 }]));
  const bySource = new Map<CallSource, { source: CallSource; calls: number; seconds: number }>();
  for (const r of rows) {
    const calls = Number(r.calls);
    const seconds = Number(r.seconds);
    totals.calls += calls;
    totals.connected += Number(r.connected);
    totals.seconds += seconds;
    totals.costCents += Number(r.cost_cents);
    const d = daily.get(r.day)!;
    d.calls += calls;
    d.seconds += seconds;
    const s = bySource.get(r.source) ?? { source: r.source, calls: 0, seconds: 0 };
    s.calls += calls;
    s.seconds += seconds;
    bySource.set(r.source, s);
  }

  const visitors = new Map(
    (funnel.data as { event: string; visitors: number }[]).map((f) => [f.event, Number(f.visitors)])
  );

  const pageStats = new Map<string, { page: string; calls: number; seconds: number }>();
  for (const p of pages.data as { page_url: string; duration_ms: number | null }[]) {
    const s = pageStats.get(p.page_url) ?? { page: p.page_url, calls: 0, seconds: 0 };
    s.calls += 1;
    s.seconds += Math.round((p.duration_ms ?? 0) / 1000);
    pageStats.set(p.page_url, s);
  }

  return {
    days,
    timezone: ANALYTICS_TZ,
    totals,
    daily: [...daily.values()],
    bySource: [...bySource.values()].sort((a, b) => b.calls - a.calls),
    funnel: {
      loaded: visitors.get('loaded') ?? 0,
      opened: visitors.get('opened') ?? 0,
      callStarted: visitors.get('call_started') ?? 0,
    },
    topPages: [...pageStats.values()].sort((a, b) => b.calls - a.calls).slice(0, TOP_PAGES),
  };
}
