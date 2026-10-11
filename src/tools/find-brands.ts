/**
 * `find_brands` — tracked brands in a market, ranked by current email
 * frequency. Answers "Which brands email most frequently in Swedish
 * ecommerce?" and lets the model find a concrete brand for "a Swedish fashion
 * brand". Names, categories and emails/week only — every one of those is
 * already printed on the brands' public pages.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  READ_ONLY_ANNOTATIONS,
  SOURCE_LINE,
  defaultLog,
  describeApiError,
  errorCode,
  toolError,
  toolMeta,
  toolResult,
  type ToolDeps,
} from './shared.js';

export function registerFindBrandsTool(server: McpServer, deps: ToolDeps): void {
  const log = deps.log ?? defaultLog;

  server.registerTool(
    'find_brands',
    {
      title: 'Find brands by email frequency',
      description:
        'Ecommerce brands StackEnhance Signal tracks in one market, ranked by current email frequency (average marketing emails per week over the last 90 days), ' +
        'optionally within a category such as "Fashion & Apparel" or "Home & Interior". ' +
        'Use for questions like "Which brands email most frequently in Swedish ecommerce?" or to find a brand when the user names a kind of brand ("a Swedish fashion brand"). ' +
        'Rankings are available for SE, NO, DK, FI and DE. Brands with too little observed data are left out of rankings. ' +
        'Returns brand names, categories and emails per week only. Each brand has a details_url to cite.',
      inputSchema: {
        market: z
          .string()
          .trim()
          .min(2)
          .max(32)
          .describe('Country as a two-letter code (SE, NO, DK, FI or DE) or its name ("Sweden").'),
        category: z
          .string()
          .trim()
          .max(60)
          .optional()
          .describe(
            'Optional category, e.g. "Fashion & Apparel", "Home & Interior", "Beauty & Cosmetics", "Sports & Outdoor".'
          ),
        limit: z.number().int().min(1).max(10).optional().describe('How many brands to return (1-10, default 10).'),
      },
      outputSchema: {
        market: z.string(),
        category: z.string().nullable(),
        window_days: z.number().int(),
        brands_tracked: z.number().int(),
        brands: z.array(
          z.object({
            brand: z.string(),
            category: z.string().nullable(),
            emails_per_week: z.number(),
            details_url: z.string(),
          })
        ),
      },
      annotations: { title: 'Find brands by email frequency', ...READ_ONLY_ANNOTATIONS },
      _meta: toolMeta('Ranking brands by email frequency…', 'Ranked brands'),
    },
    async ({ market, category, limit }) => {
      const started = Date.now();
      const done = (ok: boolean, code?: string) =>
        log({ evt: 'tool_call', tool: 'find_brands', market, category, limit, ok, code, ms: Date.now() - started });
      try {
        const fact = await deps.api.topSenders(market, category, limit);
        const scope = `${fact.category ? `${fact.category} ` : ''}brands in ${fact.market}`;
        const lines = fact.brands.map(
          (b, i) =>
            `${i + 1}. ${b.brand} — ${b.emails_per_week} emails/week${b.category && !fact.category ? ` (${b.category})` : ''} — ${b.details_url}`
        );
        const sentence =
          fact.brands.length === 0
            ? `StackEnhance Signal has no ${scope} with enough recent data to rank.`
            : `Most frequent email senders among ${fact.brands_tracked} tracked ${scope} (average emails per week, last ${fact.window_days} days):\n${lines.join('\n')}`;
        done(true);
        return toolResult(`${sentence}\n${SOURCE_LINE} (stackenhance.com)`, { ...fact });
      } catch (error) {
        done(false, errorCode(error));
        return toolError(describeApiError(error));
      }
    }
  );
}
