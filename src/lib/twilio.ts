import 'server-only';

// Minimal Twilio REST client (fetch + Basic auth) for buying numbers on our account and
// attaching them to the Elastic SIP trunk that Retell calls through. Off until
// TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set.

const API = 'https://api.twilio.com/2010-04-01';
const TRUNKING = 'https://trunking.twilio.com/v1';
const PRICING = 'https://pricing.twilio.com/v1';

export class TwilioError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function env() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim(),
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim(),
    trunkSid: process.env.TWILIO_TRUNK_SID?.trim(),
    terminationUri: process.env.TWILIO_SIP_TERMINATION_URI?.trim(),
    sipUsername: process.env.TWILIO_SIP_USERNAME?.trim(),
    sipPassword: process.env.TWILIO_SIP_PASSWORD?.trim(),
  };
}

/** True when we can buy Twilio numbers and import them into Retell over our trunk. */
export function twilioConfigured() {
  const e = env();
  return Boolean(e.accountSid && e.authToken && e.terminationUri);
}

/** Our trunk's termination URI and credentials, used when importing a number into Retell. */
export function trunkCredentials() {
  const e = env();
  if (!e.terminationUri) throw new TwilioError('Twilio SIP trunk isn’t configured', 503);
  return { termination_uri: e.terminationUri, username: e.sipUsername, password: e.sipPassword };
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, form?: Record<string, string>): Promise<T> {
  const { accountSid, authToken } = env();
  if (!accountSid || !authToken) throw new TwilioError('Twilio isn’t configured', 503);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Twilio's messages are written for developers but are clear enough to show to an admin
    throw new TwilioError(`Twilio: ${data.message ?? `request failed (${res.status})`}`, res.status === 404 ? 404 : 502);
  }
  return data as T;
}

function account() {
  return `${API}/Accounts/${env().accountSid}`;
}

export type AvailableNumber = { e164: string; locality: string | null; region: string | null; type: 'local' | 'mobile' };

/** Voice-capable numbers for sale. Countries without local numbers (e.g. PH) fall back to mobile. */
export async function searchAvailableNumbers(country: string, areaCode?: string): Promise<AvailableNumber[]> {
  const found: AvailableNumber[] = [];
  for (const type of ['local', 'mobile'] as const) {
    const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '20', ...(areaCode && { AreaCode: areaCode }) });
    const path = `${account()}/AvailablePhoneNumbers/${country}/${type === 'local' ? 'Local' : 'Mobile'}.json?${query}`;
    const data = await request<{ available_phone_numbers?: { phone_number: string; locality?: string; region?: string }[] }>(
      'GET',
      path
    ).catch((err) => {
      // Not every country sells both types
      if (err instanceof TwilioError && err.status === 404) return { available_phone_numbers: [] };
      throw err;
    });
    for (const n of data.available_phone_numbers ?? []) {
      found.push({ e164: n.phone_number, locality: n.locality || null, region: n.region || null, type });
    }
    if (found.length) break;
  }
  return found;
}

/** Monthly price per number type for a country, in US cents. */
export async function monthlyPrices(country: string): Promise<Partial<Record<'local' | 'mobile', number>>> {
  const data = await request<{ phone_number_prices?: { number_type: string; current_price: string }[]; price_unit?: string }>(
    'GET',
    `${PRICING}/PhoneNumbers/Countries/${country}`
  );
  if (data.price_unit && data.price_unit.toUpperCase() !== 'USD') return {};
  const prices: Partial<Record<'local' | 'mobile', number>> = {};
  for (const p of data.phone_number_prices ?? []) {
    if (p.number_type === 'local' || p.number_type === 'mobile') prices[p.number_type] = Math.round(Number(p.current_price) * 100);
  }
  return prices;
}

/** Buys a number on our account. Returns its SID. */
export async function buyNumber(e164: string): Promise<string> {
  const data = await request<{ sid: string }>('POST', `${account()}/IncomingPhoneNumbers.json`, { PhoneNumber: e164 });
  return data.sid;
}

async function trunkSid(): Promise<string> {
  const e = env();
  if (e.trunkSid) return e.trunkSid;
  const data = await request<{ trunks: { sid: string; domain_name: string }[] }>('GET', `${TRUNKING}/Trunks?PageSize=50`);
  const trunk = data.trunks.find((t) => t.domain_name === e.terminationUri);
  if (!trunk) throw new TwilioError(`No Twilio SIP trunk matches ${e.terminationUri}; set TWILIO_TRUNK_SID`, 503);
  return trunk.sid;
}

/** Routes the number through our Elastic SIP trunk (inbound goes to Retell via the trunk's origination URI). */
export async function attachToTrunk(numberSid: string): Promise<void> {
  await request('POST', `${TRUNKING}/Trunks/${await trunkSid()}/PhoneNumbers`, { PhoneNumberSid: numberSid });
}

export async function findNumberSid(e164: string): Promise<string | null> {
  const data = await request<{ incoming_phone_numbers: { sid: string }[] }>(
    'GET',
    `${account()}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: e164 })}`
  );
  return data.incoming_phone_numbers[0]?.sid ?? null;
}

/** Releases a number from our account, which stops its monthly charge. Already-released numbers are fine. */
export async function releaseNumber(numberSid: string): Promise<void> {
  await request('DELETE', `${account()}/IncomingPhoneNumbers/${numberSid}.json`).catch((err) => {
    if (!(err instanceof TwilioError && err.status === 404)) throw err;
  });
}
