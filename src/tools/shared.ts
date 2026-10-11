/**
 * Shared plumbing for the Signal MCP tools: brand resolution, result/error
 * shaping, and one structured log line per tool call.
 *
 * Error results are `isError: true` with a plain sentence the model can relay
 * — "not tracked in NO; tracked in DE, DK, FI, NL, SE" is an answer, not a
 * failure, and it should read like one.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SignalApiError, type LookupMatch, type SignalApi } from '../api.js';

export const SOURCE_LINE = 'Source: StackEnhance Signal';

/** Every tool is read-only and touches only Signal's own data. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * OpenAI Apps SDK tool metadata (developers.openai.com/apps-sdk/reference,
 * read 2026-10-02): `securitySchemes` declares the tool callable anonymously
 * (the `_meta` mirror — the TS SDK forwards `_meta`, not unknown top-level
 * keys), and the two status lines ChatGPT shows while / after the tool runs.
 * Each status line is ≤ 64 characters (enforced in tools.test.ts).
 */
export const STATUS_TEXT_MAX = 64;

export function toolMeta(invoking: string, invoked: string): Record<string, unknown> {
  return {
    securitySchemes: [{ type: 'noauth' }],
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked,
  };
}

export interface ToolDeps {
  api: SignalApi;
  log?: (entry: Record<string, unknown>) => void;
}

export function defaultLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ svc: 'signal-mcp', ...entry }));
}

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function toolResult<T extends Record<string, unknown>>(sentence: string, data: T): CallToolResult {
  return {
    content: [{ type: 'text', text: `${sentence}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

export type BrandResolution =
  /** One brand — or every market of ONE company, when no single market was asked for. */
  | { kind: 'ok'; matches: LookupMatch[] }
  | { kind: 'not_found' }
  | { kind: 'not_in_market'; availableMarkets: string[] }
  | { kind: 'ambiguous'; candidates: LookupMatch[] };

/**
 * Name (+ optional market) → the brand storefront(s) to answer for, or a
 * reason why not. The API already expands to the brand family, so "Newport" +
 * "NO" finds the Norwegian storefront even though it is named "Newporthome".
 *
 * Several storefronts of ONE company (the API's `same_company`) are an
 * answer, not an ambiguity: "how many emails did Newport send in August?"
 * gets one figure per market. Matches across DIFFERENT companies ("Lamp")
 * still go back to the user.
 */
export async function resolveBrand(api: SignalApi, brand: string, market?: string): Promise<BrandResolution> {
  const { matches, available_markets, same_company } = await api.lookupBrand(brand, market);
  if (matches.length === 0) {
    return available_markets && available_markets.length > 0
      ? { kind: 'not_in_market', availableMarkets: available_markets }
      : { kind: 'not_found' };
  }
  if (matches.length === 1) return { kind: 'ok', matches };
  // One company, several markets: answer for all of them, in a stable order.
  if (same_company) {
    return { kind: 'ok', matches: [...matches].sort((a, b) => (a.market ?? '~').localeCompare(b.market ?? '~')) };
  }
  // Several companies in the asked market: an exact name wins if it is unique.
  if (market) {
    const exact = matches.filter((m) => m.exact);
    if (exact.length === 1) return { kind: 'ok', matches: exact };
  }
  return { kind: 'ambiguous', candidates: matches };
}

/** A storefront the fan-out could not answer for, and the API's reason. */
export interface Unavailable {
  brand: string;
  market: string | null;
  reason: string;
}

/**
 * Ask every resolved storefront in parallel. A market that cannot answer
 * (e.g. the period predates Signal observing it) is reported beside the
 * others instead of failing the whole question.
 */
export async function fanOut<T>(
  matches: LookupMatch[],
  ask: (m: LookupMatch) => Promise<T>
): Promise<{ results: T[]; unavailable: Unavailable[]; firstError: unknown }> {
  const settled = await Promise.allSettled(matches.map(ask));
  const results: T[] = [];
  const unavailable: Unavailable[] = [];
  let firstError: unknown = null;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push(s.value);
    else {
      firstError ??= s.reason;
      unavailable.push({ brand: matches[i].brand, market: matches[i].market, reason: describeApiError(s.reason) });
    }
  });
  return { results, unavailable, firstError };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2026-08" → "August 2026"; "2025" → "2025"; "a/b" → "a to b". */
export function humanPeriod(period: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]}`;
  if (period.includes('/')) return period.replace('/', ' to ');
  return period;
}

/** "Newport (SE)" — or "Newporthome (NO)" for a storefront named differently. */
export function storefront(name: string, market: string | null): string {
  return market ? `${name} (${market})` : name;
}

/** The sentence for a resolution that did not land on one brand. */
export function describeUnresolved(
  brand: string,
  market: string | undefined,
  r: Exclude<BrandResolution, { kind: 'ok' }>
): string {
  switch (r.kind) {
    case 'not_found':
      return `StackEnhance Signal does not track a brand matching "${brand}". It covers ecommerce brands with a public StackEnhance page, mostly in Sweden, Norway, Denmark, Finland and Germany.`;
    case 'not_in_market':
      return `StackEnhance Signal tracks "${brand}" but not in market ${market}. Tracked markets for this brand: ${r.availableMarkets.join(', ')}.`;
    case 'ambiguous': {
      const list = r.candidates
        .map((c) => `${c.brand}${c.market ? ` (${c.market})` : ''} — ${c.details_url}`)
        .join('; ');
      return `"${brand}" matches more than one tracked brand or market. Call again with \`market\` (and/or a more specific brand name). Candidates: ${list}.`;
    }
  }
}

/** Map an API failure to a sentence. Validation messages pass through. */
export function describeApiError(error: unknown): string {
  if (error instanceof SignalApiError) {
    if (error.status === 429) return 'The Signal data API is rate-limited right now. Please try again in a minute.';
    if (error.status === 404) return 'StackEnhance Signal does not track that brand.';
    if (error.status >= 400 && error.status < 500) return error.message;
  }
  return 'The Signal data API is temporarily unavailable. Please try again shortly.';
}

export function errorCode(error: unknown): string {
  if (error instanceof SignalApiError) return error.code ?? `http_${error.status}`;
  return 'internal';
}
