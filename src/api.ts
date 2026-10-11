/**
 * Client for the public Signal facts API (`backend/src/routes/api/public-signal-facts.ts`).
 *
 * This is the MCP server's ONLY data source. Four narrow GETs, no query
 * builder, no passthrough of arbitrary parameters. Responses are additionally
 * narrowed to an allow-list of keys before they leave this module — the API
 * is the boundary that matters, this is the second line.
 */

import type { SignalMcpConfig } from './config.js';

const TIMEOUT_MS = 8_000;
const USER_AGENT = 'signal-mcp/1.0 (+https://stackenhance.com/signal)';

export interface LookupMatch {
  brand: string;
  market: string | null;
  category: string | null;
  slug: string;
  details_url: string;
  exact: boolean;
}

export interface LookupResult {
  matches: LookupMatch[];
  /** All matches are storefronts of one company (one answer per market). */
  same_company?: boolean;
  available_markets?: string[];
}

/** A subject line the brand's public page already shows, sent in the period. */
export interface PublicSubject {
  subject: string;
  /** Brand-local YYYY-MM-DD. */
  date: string;
}

export interface EmailFrequencyFact {
  brand: string;
  market: string | null;
  period: string;
  emails_sent: number;
  /** Brand-local YYYY-MM-DD per send, ascending; only for periods of ≤ 31 days. */
  send_dates?: string[];
  /** 0–2 subjects the public brand page already shows, sent in this period. */
  public_subjects?: PublicSubject[];
  average_per_week: number | null;
  tracked_since: string;
  details_url: string;
  note?: string;
}

export interface BrandSummaryFact {
  brand: string;
  market: string | null;
  category: string | null;
  tracked_since: string | null;
  total_observed_emails: number;
  current_emails_per_week: number;
  latest_observed_campaign_date: string | null;
  details_url: string;
}

export interface TopSendersFact {
  market: string;
  category: string | null;
  window_days: number;
  brands_tracked: number;
  brands: Array<{ brand: string; category: string | null; emails_per_week: number; details_url: string }>;
}

/** A non-2xx answer from the API, carrying its machine-readable `code`. */
export class SignalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'SignalApiError';
  }
}

export const FREQUENCY_KEYS = [
  'brand',
  'market',
  'period',
  'emails_sent',
  'send_dates',
  'average_per_week',
  'tracked_since',
  'public_subjects',
  'details_url',
  'note',
] as const;
const PUBLIC_SUBJECT_KEYS = ['subject', 'date'] as const;
/** The API's own cap; repeated here so a wider answer cannot pass through. */
export const MAX_PUBLIC_SUBJECTS = 2;
export const SUMMARY_KEYS = [
  'brand',
  'market',
  'category',
  'tracked_since',
  'total_observed_emails',
  'current_emails_per_week',
  'latest_observed_campaign_date',
  'details_url',
] as const;
const MATCH_KEYS = ['brand', 'market', 'category', 'slug', 'details_url', 'exact'] as const;
const TOP_SENDER_KEYS = ['brand', 'category', 'emails_per_week', 'details_url'] as const;

/** Copy only the named keys that are present. */
export function pick<T>(obj: unknown, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === 'object') {
    for (const k of keys) {
      if (k in obj) out[k] = (obj as Record<string, unknown>)[k];
    }
  }
  return out as T;
}

export interface SignalApi {
  lookupBrand(name: string, market?: string): Promise<LookupResult>;
  emailFrequency(slug: string, from: string, to: string): Promise<EmailFrequencyFact>;
  summary(slug: string): Promise<BrandSummaryFact>;
  topSenders(market: string, category?: string, limit?: number): Promise<TopSendersFact>;
}

/**
 * Who this request serves, sent to the backend so it can record usage
 * (`signal_mcp_events`, the admin `/admin/signal-mcp` page). One MCP request
 * carries at most one tool call (batches are refused in `http.ts`), so one
 * context = one tool call; every facts request it makes shares the call id.
 * Nothing here identifies a person: a tool name, a random id, and the AI
 * client's User-Agent (ChatGPT, Claude, …).
 */
export interface SignalCallContext {
  tool?: string;
  callId?: string;
  clientUserAgent?: string;
}

/** Header values are clipped to printable ASCII — a UA is caller-supplied,
 *  and `fetch` THROWS on a header value with CR/LF or a non-Latin-1 character,
 *  which would turn a telemetry header into a failed tool call. */
function headerValue(value: string, max: number): string {
  return value.replace(/[^\x20-\x7e]/g, '').slice(0, max);
}

export function createSignalApi(
  config: SignalMcpConfig,
  fetchImpl: typeof fetch = fetch,
  context: SignalCallContext = {}
): SignalApi {
  async function get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(`${config.apiBaseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (config.mcpKey) headers['X-Signal-Mcp-Key'] = config.mcpKey;
    if (context.tool) headers['X-Signal-Tool'] = headerValue(context.tool, 64);
    if (context.callId) headers['X-Signal-Call-Id'] = headerValue(context.callId, 64);
    if (context.clientUserAgent) headers['X-Signal-Client-UA'] = headerValue(context.clientUserAgent, 300);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
      // The timer stays armed through the BODY read: `fetch` resolves on
      // headers, and a body that dribbles would otherwise be uncapped (L79).
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw new SignalApiError(res.status, 'bad_response', 'Signal API returned a non-JSON response');
      }
      if (!res.ok) {
        const code = typeof body.code === 'string' ? body.code : undefined;
        const message = typeof body.error === 'string' ? body.error : `Signal API error ${res.status}`;
        throw new SignalApiError(res.status, code, message, body);
      }
      return body;
    } catch (error) {
      if (error instanceof SignalApiError) throw error;
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new SignalApiError(
        0,
        aborted ? 'timeout' : 'network',
        aborted ? 'Signal API timed out' : 'Signal API unreachable'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const seg = encodeURIComponent;

  return {
    async lookupBrand(name, market) {
      const body = (await get('/api/public/brand-lookup', { name, market })) as Record<string, unknown>;
      const matches = Array.isArray(body.matches) ? body.matches.map((m) => pick<LookupMatch>(m, MATCH_KEYS)) : [];
      const available = Array.isArray(body.available_markets)
        ? body.available_markets.filter((m): m is string => typeof m === 'string')
        : undefined;
      return {
        matches,
        same_company: body.same_company === true,
        ...(available ? { available_markets: available } : {}),
      };
    },
    async emailFrequency(slug, from, to) {
      const fact = pick<EmailFrequencyFact>(
        await get(`/api/public/brands/${seg(slug)}/email-frequency`, { from, to }),
        FREQUENCY_KEYS
      );
      // The nested fields are narrowed too: strings only, `subject` + `date` only, at most two.
      if ('send_dates' in fact) {
        if (Array.isArray(fact.send_dates)) {
          fact.send_dates = fact.send_dates.filter((d): d is string => typeof d === 'string');
        } else delete fact.send_dates;
      }
      if ('public_subjects' in fact) {
        fact.public_subjects = Array.isArray(fact.public_subjects)
          ? fact.public_subjects
              .map((p) => pick<PublicSubject>(p, PUBLIC_SUBJECT_KEYS))
              .filter((p) => typeof p.subject === 'string' && typeof p.date === 'string')
              .slice(0, MAX_PUBLIC_SUBJECTS)
          : [];
      }
      return fact;
    },
    async summary(slug) {
      return pick<BrandSummaryFact>(await get(`/api/public/brands/${seg(slug)}/summary`), SUMMARY_KEYS);
    },
    async topSenders(market, category, limit) {
      const body = (await get(`/api/public/markets/${seg(market)}/top-senders`, { category, limit })) as Record<
        string,
        unknown
      >;
      return {
        market: String(body.market ?? market),
        category: typeof body.category === 'string' ? body.category : null,
        window_days: Number(body.window_days ?? 90),
        brands_tracked: Number(body.brands_tracked ?? 0),
        brands: Array.isArray(body.brands)
          ? body.brands.map((b) => pick<TopSendersFact['brands'][number]>(b, TOP_SENDER_KEYS))
          : [],
      };
    },
  };
}
