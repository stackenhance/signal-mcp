/**
 * `get_brand_summary` — what Signal knows about a brand at a glance: market,
 * category, tracked since, emails observed in the last 6 months (the field
 * keeps its reviewed name `total_observed_emails`), current frequency, latest
 * observed campaign DATE. Never a campaign itself. One summary per market
 * when a brand is tracked in several and none was named.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrandSummaryFact } from '../api.js';
import { brandInput, unavailableSchema } from './brand-frequency.js';
import {
  READ_ONLY_ANNOTATIONS,
  SOURCE_LINE,
  archiveLine,
  withLine,
  defaultLog,
  describeApiError,
  describeUnresolved,
  errorCode,
  fanOut,
  resolveBrand,
  storefront,
  toolError,
  toolMeta,
  toolResult,
  type ToolDeps,
} from './shared.js';

const summaryFactSchema = z.object({
  brand: z.string(),
  market: z.string().nullable(),
  category: z.string().nullable(),
  tracked_since: z.string().nullable(),
  total_observed_emails: z.number().int(),
  current_emails_per_week: z.number(),
  latest_observed_campaign_date: z.string().nullable(),
  /** Position among the market's ranked senders by emails per week; null/absent when unranked. */
  market_rank: z.object({ rank: z.number().int(), of: z.number().int(), market: z.string() }).nullable().optional(),
  details_url: z.string(),
});

const FREQUENCY_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the weekly figure is an average OVER. The API counts it over the last
 * 90 days, or since Signal began following the brand when that is later
 * (backend `brandProfileData/frequency.ts`, 2026-11-04) — so a brand first
 * observed 20 days ago must not be described as a 90-day average.
 */
export function rateBasis(trackedSince: string | null, now: Date = new Date()): string {
  const t = trackedSince ? Date.parse(`${trackedSince}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && now.getTime() - t < FREQUENCY_WINDOW_DAYS * DAY_MS
    ? `average since Signal began tracking it on ${trackedSince}`
    : '90-day average';
}

/**
 * A brand with nothing observed in 90 days is stated as what Signal SAW, never
 * as "sends 0 emails a week": it may have stopped, or Signal may have stopped
 * receiving it, and the data cannot tell those apart (L190).
 */
/** "#4 of 212 ranked SE brands by emails per week" — the position in `find_brands`' own list; '' when unranked. */
export function rankPhrase(s: BrandSummaryFact): string {
  const r = s.market_rank;
  return r ? `#${r.rank} of ${r.of} ranked ${r.market} brands by emails per week` : '';
}

function cadence(s: BrandSummaryFact): string {
  const latest = s.latest_observed_campaign_date ? `; the latest is dated ${s.latest_observed_campaign_date}` : '';
  return s.current_emails_per_week > 0
    ? `about ${s.current_emails_per_week} marketing emails per week (${rateBasis(s.tracked_since)})${latest}`
    : `no marketing emails observed in the last 90 days${latest}`;
}

export function registerBrandSummaryTool(server: McpServer, deps: ToolDeps): void {
  const log = deps.log ?? defaultLog;

  server.registerTool(
    'get_brand_summary',
    {
      title: 'Brand email summary',
      description:
        "A brand's email-marketing profile as observed by StackEnhance Signal: market, category, the date Signal first observed it, " +
        'marketing emails observed in the last 6 months, current frequency (average emails per week over the last 90 days), the date of the latest observed campaign and, for brands Signal has followed 28+ days in SE, NO, DK, FI or DE, its rank in that market by frequency. ' +
        'Use for questions like "How often does Newport email customers?" or "Is IKEA still sending newsletters?". ' +
        'Without a market, a brand tracked in several countries gets one summary per market. ' +
        'For two or more named brands use compare_brands instead of calling this once per brand. ' +
        "Returns aggregates only — no campaign list, subject lines, offers or creative analysis. Cite each result's details_url as the source.",
      inputSchema: brandInput,
      outputSchema: { results: z.array(summaryFactSchema), unavailable: unavailableSchema },
      annotations: { title: 'Brand email summary', ...READ_ONLY_ANNOTATIONS },
      _meta: toolMeta("Looking up the brand's email activity…", 'Found email activity'),
    },
    async ({ brand, market }) => {
      const started = Date.now();
      const done = (ok: boolean, code?: string, markets?: number) =>
        log({
          evt: 'tool_call',
          tool: 'get_brand_summary',
          brand,
          market,
          ok,
          code,
          markets,
          ms: Date.now() - started,
        });
      try {
        const resolved = await resolveBrand(deps.api, brand, market);
        if (resolved.kind !== 'ok') {
          done(false, resolved.kind);
          return toolError(describeUnresolved(brand, market, resolved));
        }
        const { results, unavailable, firstError } = await fanOut(resolved.matches, (m) => deps.api.summary(m.slug));
        if (results.length === 0) {
          done(false, errorCode(firstError));
          return toolError(describeApiError(firstError));
        }

        let text: string;
        if (results.length === 1 && unavailable.length === 0) {
          const s = results[0];
          text =
            `${storefront(s.brand, s.market)}: ${cadence(s)}. ` +
            `Signal observed ${s.total_observed_emails} of its marketing emails in the last 6 months${s.tracked_since ? ` (tracked since ${s.tracked_since})` : ''}.` +
            (s.category ? ` Category: ${s.category}.` : '') +
            (rankPhrase(s) ? ` Ranks ${rankPhrase(s)}.` : '') +
            `\n${SOURCE_LINE} — campaign, content and competitive detail for ${s.brand}: ${s.details_url}` +
            withLine(archiveLine([s], 'summary'));
        } else {
          const lines = results.map(
            (s) =>
              `- ${storefront(s.brand, s.market)}: ${cadence(s)}; ${s.total_observed_emails} observed in the last 6 months${s.tracked_since ? ` (tracked since ${s.tracked_since})` : ''}${rankPhrase(s) ? `; ${rankPhrase(s)}` : ''} — ${s.details_url}`
          );
          for (const u of unavailable) lines.push(`- ${storefront(u.brand, u.market)}: ${u.reason}`);
          text =
            `${results[0].brand} email activity by market (observed by StackEnhance Signal):\n${lines.join('\n')}\n` +
            `${SOURCE_LINE} — each market's page has its campaign, content and competitive detail.` +
            withLine(archiveLine(results, 'summary'));
        }
        done(true, undefined, results.length);
        return toolResult(text, { results, ...(unavailable.length ? { unavailable } : {}) });
      } catch (error) {
        done(false, errorCode(error));
        return toolError(describeApiError(error));
      }
    }
  );
}
