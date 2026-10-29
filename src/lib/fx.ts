import 'server-only';

// USD → PHP for showing peso prices to Philippine visitors and charging PayMongo in pesos.
// Daily rates from open.er-api.com (free, no key), cached in memory for 12 hours.

const RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const CACHE_MS = 12 * 60 * 60 * 1000;
/** Used only when the rate service is down. */
const FALLBACK_RATE = Number(process.env.USD_TO_PHP) || 64;

let cached: { rate: number; at: number } | null = null;

export async function usdToPhp(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rate;
  try {
    const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const rate = Number(data?.rates?.PHP);
    if (!res.ok || !(rate > 30 && rate < 120)) throw new Error(`unexpected rate ${data?.rates?.PHP}`);
    cached = { rate, at: Date.now() };
    return rate;
  } catch (error) {
    console.error('[fx] USD→PHP rate unavailable, using the fallback', error);
    return cached?.rate ?? FALLBACK_RATE;
  }
}

/** US cents → PHP centavos, rounded to the peso. */
export function toPhpCents(usdCents: number, rate: number) {
  return Math.round((usdCents * rate) / 100) * 100;
}

/**
 * Visitor's country from the hosting platform's IP geolocation header (Vercel or Cloudflare).
 * Locally there's no header: set DEV_VISITOR_COUNTRY=PH to try the peso display.
 */
export function visitorCountry(headers: Headers): string | null {
  return (
    headers.get('x-vercel-ip-country') ??
    headers.get('cf-ipcountry') ??
    (process.env.NODE_ENV !== 'production' ? (process.env.DEV_VISITOR_COUNTRY ?? null) : null)
  )?.toUpperCase() ?? null;
}
