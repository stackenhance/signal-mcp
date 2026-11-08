/**
 * `compare_brands` — 2 to 5 brands side by side, in ONE call.
 *
 * Built from the real queries (MCP_DEMAND_LOOP_PLAN §3.1): a marketer asks
 * about a competitor SET, and the assistant made one call per brand (nine in a
 * Swedish home-interior session). This tool answers the set at once from the
 * SAME facts the other tools use — `summary` (current frequency, last-6-months
 * total, tracked since, market rank) and, when a period is given,
 * `email-frequency` (sends in that period). It adds no data of its own and no
 * subject lines: the free tier's boundary stays in the API (`facts.ts`).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrandSummaryFact, EmailFrequencyFact, LookupMatch, MarketRank } from '../api.js';
import { rateBasis } from './brand-summary.js';
import {
  READ_ONLY_ANNOTATIONS,
  SOURCE_LINE,
  defaultLog,
  describeApiError,
  describeUnresolved,
  errorCode,
  humanPeriod,
  resolveBrand,
  storefront,
  toolError,
  toolMeta,
  toolResult,
  type ToolDeps,
  type Unavailable,
} from './shared.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_COMPARE_BRANDS = 2;
export const MAX_COMPARE_BRANDS = 5;

const rowSchema = z.object({
  brand: z.string(),
  market: z.string().nullable(),
  category: z.string().nullable(),
  emails_per_week: z.number(),
  rate_basis: z.string(),
  observed_last_6_months: z.number().int(),
  tracked_since: z.string().nullable(),
  latest_campaign_date: z.string().nullable(),
  market_rank: z.object({ rank: z.number().int(), of: z.number().int(), market: z.string() }).nullable(),
  period: z
    .object({
      label: z.string(),
      emails_sent: z.number().int().nullable(),
      average_per_week: z.number().nullable(),
      unavailable: z.string().optional(),
    })
    .optional(),
  details_url: z.string(),
});
type CompareRow = z.infer<typeof rowSchema>;

/** Pure: one comparable row from the facts. Exported for tests. */
export function toCompareRow(
  s: BrandSummaryFact,
  period?: { label: string; fact?: EmailFrequencyFact; error?: string }
): CompareRow {
  return {
    brand: s.brand,
    market: s.market,
    category: s.category,
    emails_per_week: s.current_emails_per_week,
    rate_basis: rateBasis(s.tracked_since),
    observed_last_6_months: s.total_observed_emails,
    tracked_since: s.tracked_since,
    latest_campaign_date: s.latest_observed_campaign_date,
    market_rank: (s.market_rank as MarketRank | null | undefined) ?? null,
    ...(period
      ? {
          period: {
            label: period.label,
            emails_sent: period.fact ? period.fact.emails_sent : null,
            average_per_week: period.fact ? period.fact.average_per_week : null,
            ...(period.error ? { unavailable: period.error } : {}),
          },
        }
      : {}),
    details_url: s.details_url,
  };
}

function rowLine(r: CompareRow, i: number): string {
  const who = storefront(r.brand, r.market);
  const rate =
    r.emails_per_week > 0
      ? `about ${r.emails_per_week} emails/week (${r.rate_basis})`
      : 'no marketing emails observed in the last 90 days';
  const parts = [rate, `${r.observed_last_6_months} observed in the last 6 months`];
  if (r.market_rank) parts.push(`#${r.market_rank.rank} of ${r.market_rank.of} ranked ${r.market_rank.market} brands`);
  if (r.period) {
    parts.push(
      r.period.emails_sent === null
        ? `${r.period.label}: ${r.period.unavailable ?? 'not available'}`
        : `${r.period.label}: ${r.period.emails_sent} email${r.period.emails_sent === 1 ? '' : 's'}`
    );
  }
  if (r.tracked_since) parts.push(`tracked since ${r.tracked_since}`);
  return `${i + 1}. ${who}: ${parts.join('; ')} — ${r.details_url}`;
}

export function registerCompareBrandsTool(server: McpServer, deps: ToolDeps): void {
  const log = deps.log ?? defaultLog;

  server.registerTool(
    'compare_brands',
    {
      title: 'Compare brands by email frequency',
      description:
        'Compare 2 to 5 ecommerce brands side by side in ONE call, as observed by StackEnhance Signal: current frequency (average marketing emails per week, last 90 days), ' +
        "emails observed in the last 6 months, the date Signal first observed each brand, the latest campaign date, and each brand's rank in its market when it has one, ordered by frequency. " +
        'Use this instead of calling get_brand_summary repeatedly when the user names a set of brands: "Compare Mio, IKEA and Westwing", "Who emails more, Boozt or Zalando?", "How does Newport compare with its competitors?". ' +
        'Pass the brand names as the user wrote them. Give `market` (SE, NO, DK, FI, DE or a country name) when the brands are in one country, which is the usual case; ' +
        'a brand tracked in several countries without a market is listed as unavailable with the markets to choose from, never guessed. ' +
        "Optionally give `from` and `to` (YYYY-MM-DD, starting within the last six months) to also count each brand's sends in that period. " +
        'More than 5 brands: call again with the rest. To discover competitors first, use find_brands. ' +
        'Returns aggregates only: no campaign list, subject lines, offers or creative analysis. There is no open, click or revenue data. ' +
        "Cite each brand's details_url as the source.",
      inputSchema: {
        brands: z
          .array(z.string().trim().min(2).max(80))
          .min(MIN_COMPARE_BRANDS)
          .max(MAX_COMPARE_BRANDS)
          .describe('2 to 5 brand names as the user wrote them, e.g. ["Mio", "IKEA", "Westwing"].'),
        market: z
          .string()
          .trim()
          .max(32)
          .optional()
          .describe(
            'Country the brands are in, as a two-letter code (SE, NO, DK, FI, DE) or its name ("Sweden"). Not a topic or category.'
          ),
        from: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe('Optional first day of a period to also count, YYYY-MM-DD.'),
        to: z.string().regex(ISO_DATE).optional().describe('Optional last day of that period, inclusive, YYYY-MM-DD.'),
      },
      outputSchema: {
        results: z.array(rowSchema),
        unavailable: z
          .array(z.object({ brand: z.string(), market: z.string().nullable(), reason: z.string() }))
          .optional(),
      },
      annotations: { title: 'Compare brands by email frequency', ...READ_ONLY_ANNOTATIONS },
      _meta: toolMeta('Comparing the brands…', 'Compared the brands'),
    },
    async ({ brands, market, from, to }) => {
      const started = Date.now();
      const done = (ok: boolean, code?: string, rows?: number) =>
        log({
          evt: 'tool_call',
          tool: 'compare_brands',
          brands: brands.length,
          market,
          ok,
          code,
          rows,
          ms: Date.now() - started,
        });
      if ((from && !to) || (!from && to)) {
        done(false, 'invalid_period');
        return toolError('Give both `from` and `to` to count a period, or neither.');
      }
      try {
        const unavailable: Unavailable[] = [];
        const targets = new Map<string, LookupMatch>();
        const resolved = await Promise.allSettled(brands.map((b) => resolveBrand(deps.api, b, market)));
        let firstError: unknown = null;
        resolved.forEach((r, i) => {
          if (r.status === 'rejected') {
            firstError ??= r.reason;
            unavailable.push({ brand: brands[i], market: market ?? null, reason: describeApiError(r.reason) });
          } else if (r.value.kind !== 'ok') {
            unavailable.push({
              brand: brands[i],
              market: market ?? null,
              reason: describeUnresolved(brands[i], market, r.value),
            });
          } else if (r.value.matches.length > 1) {
            const markets = r.value.matches
              .map((m) => m.market)
              .filter(Boolean)
              .join(', ');
            unavailable.push({
              brand: brands[i],
              market: null,
              reason: `Tracked in several markets (${markets}). Call again with \`market\` to compare one storefront.`,
            });
          } else {
            const m = r.value.matches[0];
            if (!targets.has(m.slug)) targets.set(m.slug, m);
          }
        });

        const label = from && to ? humanPeriod(`${from}/${to}`) : '';
        const settled = await Promise.allSettled(
          [...targets.values()].map(async (m) => {
            const [summary, freq] = await Promise.all([
              deps.api.summary(m.slug),
              from && to
                ? deps.api.emailFrequency(m.slug, from, to).then(
                    (fact) => ({ fact }),
                    (error: unknown) => ({ error: describeApiError(error) })
                  )
                : Promise.resolve(null),
            ]);
            return toCompareRow(summary, freq ? { label, ...freq } : undefined);
          })
        );
        const rows: CompareRow[] = [];
        [...targets.values()].forEach((m, i) => {
          const s = settled[i];
          if (s.status === 'fulfilled') rows.push(s.value);
          else {
            firstError ??= s.reason;
            unavailable.push({ brand: m.brand, market: m.market, reason: describeApiError(s.reason) });
          }
        });

        if (rows.length === 0) {
          done(false, firstError ? errorCode(firstError) : 'nothing_to_compare');
          return toolError(
            unavailable.length ? unavailable.map((u) => `${u.brand}: ${u.reason}`).join(' ') : 'Nothing to compare.'
          );
        }
        rows.sort((a, b) => b.emails_per_week - a.emails_per_week || a.brand.localeCompare(b.brand));

        const lines = rows.map(rowLine);
        for (const u of unavailable) lines.push(`- ${u.brand}: ${u.reason}`);
        const mixedBasis = new Set(rows.map((r) => r.rate_basis)).size > 1;
        const text =
          `${rows.length} brands by current email frequency (observed by StackEnhance Signal):\n${lines.join('\n')}` +
          (mixedBasis
            ? '\nNote: rates are averages over the last 90 days, or since Signal began tracking a brand when that is more recent, so a recently tracked brand is less certain.'
            : '') +
          `\n${SOURCE_LINE} — each brand's page has its campaign, content and competitive detail.`;
        done(true, undefined, rows.length);
        return toolResult(text, { results: rows, ...(unavailable.length ? { unavailable } : {}) });
      } catch (error) {
        done(false, errorCode(error));
        return toolError(describeApiError(error));
      }
    }
  );
}
