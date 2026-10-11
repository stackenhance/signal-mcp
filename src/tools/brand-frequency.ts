/**
 * `get_brand_email_frequency` — how many marketing emails a brand sent in a
 * calendar period, and (for periods ≤ 31 days) on which dates. The
 * Definition-of-Done tool: "How many emails did Newport send in August 2026?"
 * → one figure per Newport market (SE 11, NO 10, …); "what did Newport send
 * last week?" → the count, the dates and up to two subject lines — only ones
 * the brand's public page ALREADY shows (the API decides which; this module
 * only renders them) — then the brand page for the full campaigns.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EmailFrequencyFact } from '../api.js';
import {
  READ_ONLY_ANNOTATIONS,
  defaultLog,
  describeApiError,
  describeUnresolved,
  errorCode,
  fanOut,
  humanPeriod,
  resolveBrand,
  storefront,
  toolError,
  toolMeta,
  toolResult,
  type ToolDeps,
} from './shared.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const brandInput = {
  brand: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe('Brand name as the user wrote it, e.g. "Newport" or "IKEA". A domain such as newport.se also works.'),
  market: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe(
      'Country of one storefront as a two-letter code (SE, NO, DK, FI, DE) or its name ("Sweden"). Omit it to get every market the brand is tracked in.'
    ),
};

export const unavailableSchema = z
  .array(z.object({ brand: z.string(), market: z.string().nullable(), reason: z.string() }))
  .optional();

const frequencyFactSchema = z.object({
  brand: z.string(),
  market: z.string().nullable(),
  period: z.string(),
  emails_sent: z.number().int(),
  send_dates: z.array(z.string()).optional(),
  average_per_week: z.number().nullable(),
  tracked_since: z.string(),
  public_subjects: z
    .array(z.object({ subject: z.string(), date: z.string() }))
    .max(2)
    .optional(),
  /** Sends in `send_dates` this answer does not quote a subject for. They were
   *  captured in full — the subject is withheld by the free tier's limit, not
   *  missing. Without this, an assistant renders "Subject line not available"
   *  and guesses at a capture failure (seen live in ChatGPT, 2026-10-09). */
  sends_with_subject_in_signal: z
    .object({ count: z.number().int(), dates: z.array(z.string()), note: z.string() })
    .optional(),
  details_url: z.string(),
  note: z.string().optional(),
});

const FULL_CAMPAIGNS = 'The full campaigns (previews, offers, timing, AI analysis) are in StackEnhance Signal →';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-30" → "Wed 30 Sep". Pure calendar arithmetic on the brand-local
 *  date string — no host timezone can shift it. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Wed 30 Sep, Fri 2 Oct (2 emails), Sun 4 Oct" — a day with two sends is listed once. */
export function datesList(dates: string[]): string {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([d, n]) => (n > 1 ? `${shortDate(d)} (${n} emails)` : shortDate(d))).join(', ');
}

/** `Latest two: "A" · "B"` — or nothing when no public subject is in the period. */
function subjectsLine(f: EmailFrequencyFact): string | null {
  const subjects = f.public_subjects ?? [];
  if (subjects.length === 0) return null;
  const quoted = subjects.map((p) => `"${p.subject}"`).join(' · ');
  return `${subjects.length === 1 ? 'Latest' : 'Latest two'}: ${quoted}`;
}

const hasDates = (f: EmailFrequencyFact) => f.emails_sent > 0 && (f.send_dates?.length ?? 0) > 0;

const WITHHELD_NOTE =
  'Captured in full by StackEnhance Signal; the subject lines are available there. This app quotes at most two subject lines, and only ones already shown on the brand’s public page.';

/** The listed sends this answer does NOT quote a subject for (a multiset
 *  difference: two sends on one day, one quoted, leaves one). */
export function unquotedDates(f: EmailFrequencyFact): string[] {
  if (!hasDates(f)) return [];
  const quoted = new Map<string, number>();
  for (const p of f.public_subjects ?? []) quoted.set(p.date, (quoted.get(p.date) ?? 0) + 1);
  const out: string[] = [];
  for (const d of f.send_dates as string[]) {
    const n = quoted.get(d) ?? 0;
    if (n > 0) quoted.set(d, n - 1);
    else out.push(d);
  }
  return out;
}

/** Adds `sends_with_subject_in_signal` when some listed send has no quoted subject. */
function withWithheld(f: EmailFrequencyFact): EmailFrequencyFact & {
  sends_with_subject_in_signal?: { count: number; dates: string[]; note: string };
} {
  const dates = unquotedDates(f);
  return dates.length ? { ...f, sends_with_subject_in_signal: { count: dates.length, dates, note: WITHHELD_NOTE } } : f;
}

/** "The subject of the other send (Sat 3 Oct) is in StackEnhance Signal …" */
function withheldLine(f: EmailFrequencyFact): string | null {
  const dates = unquotedDates(f);
  if (dates.length === 0) return null;
  const quotedAny = (f.public_subjects ?? []).length > 0;
  const which =
    dates.length === 1
      ? `The subject line of the ${quotedAny ? 'other send' : 'send'} (${datesList(dates)}) was`
      : `The subject lines of the ${quotedAny ? `other ${dates.length} sends` : `${dates.length} sends`} (${datesList(dates)}) were`;
  return `${which} captured too and ${dates.length === 1 ? 'is' : 'are'} in StackEnhance Signal — this app quotes at most two, and only ones already on the brand’s public page.`;
}

/**
 * A count is what Signal OBSERVED. A non-zero count proves the emails exist,
 * so "sent 11" is fair; a zero proves nothing about the brand (it may have
 * stopped, or Signal may have stopped receiving it — L190), so it is worded as
 * an observation, never "sent 0".
 */
function line(f: EmailFrequencyFact): string {
  if (f.emails_sent === 0) return 'none observed';
  const avg = f.average_per_week !== null ? `, about ${f.average_per_week} per week` : '';
  return `${f.emails_sent} marketing email${f.emails_sent === 1 ? '' : 's'}${avg}`;
}

function sentence(f: EmailFrequencyFact): string {
  const who = storefront(f.brand, f.market);
  if (f.emails_sent === 0) return `Signal observed no marketing emails from ${who} in ${humanPeriod(f.period)}.`;
  const dates = hasDates(f) ? `: ${datesList(f.send_dates as string[])}` : '';
  return `${who} sent ${line(f)} in ${humanPeriod(f.period)}${dates}.`;
}

export function registerBrandFrequencyTool(server: McpServer, deps: ToolDeps): void {
  const log = deps.log ?? defaultLog;

  server.registerTool(
    'get_brand_email_frequency',
    {
      title: 'Brand email frequency',
      description:
        'How many marketing emails a brand sent in a calendar period, and when, as observed by StackEnhance Signal ' +
        '(ecommerce brands, mostly in Sweden, Norway, Denmark, Finland and Germany). ' +
        'Use for questions like "How many emails did Newport send in August 2026?", "What did Newport send last week?" or "What has X sent recently?". ' +
        'Without a market, a brand tracked in several countries gets one result per market. ' +
        'Resolve relative dates yourself to YYYY-MM-DD: "last week" is the previous Monday–Sunday, "last month" the previous calendar month, "recently" the last 14 days. ' +
        "Dates are the brand's local calendar dates and a period may span up to two years. " +
        "Returns the count; for periods of up to 31 days also the date of each send; and at most two subject lines, only ones already shown on the brand's public StackEnhance page and sent in the period. " +
        'Every listed send was captured in full; a send without a quoted subject is listed in sends_with_subject_in_signal because its subject is withheld by that limit, not missing. ' +
        'Counts are de-duplicated marketing sends (welcome, birthday and transactional emails excluded). There is no open, click or revenue data. ' +
        'Full campaigns, other subject lines, offers, products and creative analysis are not available through this tool. ' +
        "Cite each result's details_url as the source and as where the full campaigns are.",
      inputSchema: {
        ...brandInput,
        from: z.string().regex(ISO_DATE).describe('First day of the period, YYYY-MM-DD.'),
        to: z.string().regex(ISO_DATE).describe('Last day of the period, inclusive, YYYY-MM-DD.'),
      },
      outputSchema: { results: z.array(frequencyFactSchema), unavailable: unavailableSchema },
      annotations: { title: 'Brand email frequency', ...READ_ONLY_ANNOTATIONS },
      _meta: toolMeta("Counting the brand's marketing emails…", 'Counted marketing emails'),
    },
    async ({ brand, market, from, to }) => {
      const started = Date.now();
      const done = (ok: boolean, code?: string, markets?: number) =>
        log({
          evt: 'tool_call',
          tool: 'get_brand_email_frequency',
          brand,
          market,
          from,
          to,
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
        const { results, unavailable, firstError } = await fanOut(resolved.matches, (m) =>
          deps.api.emailFrequency(m.slug, from, to)
        );
        if (results.length === 0) {
          done(false, errorCode(firstError));
          return toolError(describeApiError(firstError));
        }

        let text: string;
        if (results.length === 1 && unavailable.length === 0) {
          const f = results[0];
          const subjects = subjectsLine(f);
          const withheld = withheldLine(f);
          text =
            `${sentence(f)}` +
            (subjects ? `\n${subjects}` : '') +
            (withheld ? `\n${withheld}` : '') +
            `\nSignal has observed this brand since ${f.tracked_since}.` +
            (f.note ? ` ${f.note}` : '') +
            `\n${FULL_CAMPAIGNS} ${f.details_url}`;
        } else {
          const lines = results.map((f) => {
            const dates = hasDates(f) ? ` (${datesList(f.send_dates as string[])})` : '';
            const subjects = subjectsLine(f);
            return (
              `- ${storefront(f.brand, f.market)}: ${line(f)}${dates}${f.note ? ` (${f.note})` : ''}` +
              `${subjects ? `. ${subjects}` : ''} — ${f.details_url}`
            );
          });
          for (const u of unavailable) lines.push(`- ${storefront(u.brand, u.market)}: ${u.reason}`);
          text =
            `${results[0].brand} marketing emails in ${humanPeriod(results[0].period)}, by market (observed by StackEnhance Signal):\n` +
            `${lines.join('\n')}\n${FULL_CAMPAIGNS} ${results.map((f) => f.details_url).join(' · ')}`;
        }
        done(true, undefined, results.length);
        return toolResult(text, { results: results.map(withWithheld), ...(unavailable.length ? { unavailable } : {}) });
      } catch (error) {
        done(false, errorCode(error));
        return toolError(describeApiError(error));
      }
    }
  );
}
