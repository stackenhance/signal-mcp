/**
 * `get_brand_summary` — what Signal knows about a brand at a glance: market,
 * category, tracked since, total observed emails, current frequency, latest
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
  details_url: z.string(),
});

/**
 * A brand with nothing observed in 90 days is stated as what Signal SAW, never
 * as "sends 0 emails a week": it may have stopped, or Signal may have stopped
 * receiving it, and the data cannot tell those apart (L190).
 */
function cadence(s: BrandSummaryFact): string {
  const latest = s.latest_observed_campaign_date ? `; the latest is dated ${s.latest_observed_campaign_date}` : '';
  return s.current_emails_per_week > 0
    ? `about ${s.current_emails_per_week} marketing emails per week (90-day average)${latest}`
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
        'total marketing emails observed, current frequency (average emails per week over the last 90 days) and the date of the latest observed campaign. ' +
        'Use for questions like "How often does Newport email customers?" or "Is IKEA still sending newsletters?". ' +
        'Without a market, a brand tracked in several countries gets one summary per market. ' +
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
            `Signal has observed ${s.total_observed_emails} of its marketing emails${s.tracked_since ? ` since ${s.tracked_since}` : ''}.` +
            (s.category ? ` Category: ${s.category}.` : '') +
            `\n${SOURCE_LINE} — campaign, content and competitive detail for ${s.brand}: ${s.details_url}`;
        } else {
          const lines = results.map(
            (s) =>
              `- ${storefront(s.brand, s.market)}: ${cadence(s)}; ${s.total_observed_emails} observed${s.tracked_since ? ` since ${s.tracked_since}` : ''} — ${s.details_url}`
          );
          for (const u of unavailable) lines.push(`- ${storefront(u.brand, u.market)}: ${u.reason}`);
          text =
            `${results[0].brand} email activity by market (observed by StackEnhance Signal):\n${lines.join('\n')}\n` +
            `${SOURCE_LINE} — each market's page has its campaign, content and competitive detail.`;
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
