/**
 * End-to-end smoke test of a RUNNING Signal MCP server — the build plan's test
 * matrix, executed as a real MCP client (the SDK's own client also validates
 * every structuredContent against the tool's outputSchema).
 *
 *   npx tsx signal-mcp/src/smoke.ts https://mcp.stackenhance.com/mcp
 *   npx tsx signal-mcp/src/smoke.ts http://localhost:3333/mcp --rate
 *
 * `--rate` additionally bursts requests until the server answers 429. On
 * Vercel the per-instance cap may be spread over several instances, so it is
 * opt-in and meant for a local run; the backend tier is the real limit.
 *
 * ChatGPT prompts → tool calls (what the model is expected to do):
 *   1 "How many emails did Newport send in August 2026?" → get_brand_email_frequency
 *   2 "How often does IKEA email customers?"              → get_brand_summary
 *   3 "…a Swedish fashion brand send last month?"         → find_brands → get_brand_email_frequency
 *   4-6 "Show me all Newport emails / subject lines / product+discount data"
 *       → no tool can return them: asserted on the tool list and on every
 *         result's keys. The one subject exception (≤ 2 per result, only ones
 *         the public brand page already shows) is capped and shaped here.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? 'http://localhost:3333/mcp';
const withRate = process.argv.includes('--rate');

const EXPECTED_TOOLS = ['find_brands', 'get_brand_email_frequency', 'get_brand_summary'];
const ALLOWED_KEYS = new Set([
  // frequency
  'brand',
  'market',
  'period',
  'emails_sent',
  'send_dates',
  'average_per_week',
  'tracked_since',
  'public_subjects',
  'subject', // only inside public_subjects — checked separately below
  'date',
  'details_url',
  'note',
  // summary
  'category',
  'total_observed_emails',
  'current_emails_per_week',
  'latest_observed_campaign_date',
  // find_brands
  'window_days',
  'brands_tracked',
  'brands',
  'emails_per_week',
  // per-market wrapper (v1.1)
  'results',
  'unavailable',
  'reason',
]);
const PREMIUM_WORDS = /campaign_list|subject|body|html|discount|offer|product|creative|search|query|sql/i;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function keysDeep(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keysDeep);
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]);
  return [];
}

function lastMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

type Result = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
const text = (r: Result) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

async function main(): Promise<void> {
  console.log(`Signal MCP smoke test → ${url}\n`);
  const client = new Client({ name: 'signal-mcp-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;
  const allowedOnly = (r: Result) => keysDeep(r.structuredContent).every((k) => ALLOWED_KEYS.has(k));

  // ── Tool surface: the data boundary as the client sees it ──
  const info = client.getServerVersion();
  check('server identifies as Signal by StackEnhance', info?.title === 'Signal by StackEnhance', JSON.stringify(info));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('exactly the three public tools', JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(', '));
  check(
    'every tool is read-only',
    tools.every((t) => t.annotations?.readOnlyHint === true)
  );
  check(
    'every tool declares an output schema',
    tools.every((t) => !!t.outputSchema)
  );
  check(
    'no tool exposes campaign/subject/offer/product/search inputs',
    tools.every(
      (t) =>
        !PREMIUM_WORDS.test(t.name) && Object.keys(t.inputSchema.properties ?? {}).every((p) => !PREMIUM_WORDS.test(p))
    )
  );

  // ── 1. "How many emails did Newport send in August 2026?" ──
  const r1 = await call('get_brand_email_frequency', {
    brand: 'Newport',
    market: 'SE',
    from: '2026-08-01',
    to: '2026-08-31',
  });
  const first = (r: Result) => (((r.structuredContent ?? {}).results as Array<Record<string, unknown>>) ?? [])[0] ?? {};
  const s1 = first(r1);
  check(
    '1 Newport SE, Aug 2026 → a count with a brand-page link',
    !r1.isError &&
      typeof s1.emails_sent === 'number' &&
      s1.details_url === 'https://stackenhance.com/brands/newport-se',
    `${s1.emails_sent} emails, ${s1.average_per_week}/wk`
  );
  check('1 only allowed fields', allowedOnly(r1));
  check('1 text cites StackEnhance Signal', text(r1).includes('StackEnhance Signal'));

  // ── 1b. The plan's exact question — no market named ──
  const r1b = await call('get_brand_email_frequency', { brand: 'Newport', from: '2026-08-01', to: '2026-08-31' });
  const markets1b = (((r1b.structuredContent ?? {}).results as Array<Record<string, unknown>>) ?? []).map(
    (x) => `${x.market}:${x.emails_sent}`
  );
  check(
    '1b "How many emails did Newport send in August 2026?" → one figure per market',
    !r1b.isError && markets1b.length >= 2 && markets1b.some((m) => m.startsWith('SE:')),
    markets1b.join(' ')
  );
  check('1b only allowed fields', allowedOnly(r1b));

  // ── 2. "How often does IKEA email customers?" ──
  const r2 = await call('get_brand_summary', { brand: 'IKEA' });
  const s2 = first(r2);
  check(
    '2 IKEA summary → current frequency',
    !r2.isError && typeof s2.current_emails_per_week === 'number',
    `${s2.current_emails_per_week}/wk`
  );
  check(
    '2 a brand silent for 90 days is described as observed, never "about 0 per week"',
    s2.current_emails_per_week !== 0 || (!/about 0 /.test(text(r2)) && /no marketing emails observed/.test(text(r2)))
  );
  check('2 only allowed fields', allowedOnly(r2));

  // ── 3. "How many emails did a Swedish fashion brand send last month?" ──
  const r3 = await call('find_brands', { market: 'SE', category: 'fashion', limit: 5 });
  const brands = ((r3.structuredContent ?? {}).brands as Array<Record<string, unknown>>) ?? [];
  check(
    '3a find_brands SE fashion → ranked brands',
    !r3.isError && brands.length > 0,
    brands.map((b) => b.brand).join(', ')
  );
  check('3a only allowed fields', allowedOnly(r3));
  if (brands.length > 0) {
    const r3b = await call('get_brand_email_frequency', {
      brand: String(brands[0].brand),
      market: 'SE',
      ...lastMonth(),
    });
    check(
      '3b frequency for the top fashion brand, last month',
      !r3b.isError && allowedOnly(r3b),
      text(r3b).split('\n')[0]
    );
  }

  // ── 4-6. Premium data is not reachable ──
  for (const r of [r1, r2, r3]) {
    check(
      '4-6 no subject lists / campaigns / offers in any result',
      !/"(subjects|campaigns|offers|products|discount)"/i.test(text(r))
    );
  }
  for (const r of [r1, r1b]) {
    const results = ((r.structuredContent ?? {}).results as Array<Record<string, unknown>>) ?? [];
    check(
      '4-6 at most two public subjects per result, each {subject, date} only',
      results.every((x) => {
        const ps = (x.public_subjects ?? []) as Array<Record<string, unknown>>;
        return ps.length <= 2 && ps.every((p) => Object.keys(p).sort().join() === 'date,subject');
      })
    );
    check(
      '4-6 `subject` appears nowhere outside public_subjects',
      results.every(({ public_subjects: _ps, ...rest }) => !keysDeep(rest).includes('subject'))
    );
  }

  // ── Validation / boundaries ──
  const unknownBrand = await call('get_brand_summary', { brand: 'Xyzzy Nonexistent Brand' });
  check(
    'unknown brand → explained, not a crash',
    !!unknownBrand.isError && /does not track/i.test(text(unknownBrand)),
    text(unknownBrand)
  );

  const unknownMarket = await call('get_brand_summary', { brand: 'Newport', market: 'FR' });
  check(
    'unknown market → lists tracked markets',
    !!unknownMarket.isError && /tracked markets/i.test(text(unknownMarket)),
    text(unknownMarket)
  );

  const mismatch = await call('get_brand_summary', { brand: 'IKEA', market: 'NO' });
  check(
    'brand/market mismatch → lists tracked markets',
    !!mismatch.isError && /SE/.test(text(mismatch)),
    text(mismatch)
  );

  const ambiguous = await call('get_brand_summary', { brand: 'Lamp' });
  check(
    'a name matching DIFFERENT companies → asks which',
    !!ambiguous.isError && /market/i.test(text(ambiguous)),
    text(ambiguous).slice(0, 120)
  );

  const familyName = await call('get_brand_summary', { brand: 'Newport', market: 'NO' });
  check(
    'family member under another name (Newport NO = Newporthome)',
    !familyName.isError,
    text(familyName).split('\n')[0]
  );

  const badDate = await call('get_brand_email_frequency', {
    brand: 'Newport',
    market: 'SE',
    from: '2026-02-30',
    to: '2026-03-01',
  });
  check(
    'impossible date → validation message',
    !!badDate.isError && /calendar dates/i.test(text(badDate)),
    text(badDate)
  );

  const future = await call('get_brand_email_frequency', {
    brand: 'Newport',
    market: 'SE',
    from: '2030-01-01',
    to: '2030-01-31',
  });
  check('future period → refused, not zero', !!future.isError && /after today/i.test(text(future)), text(future));

  const unrankable = await call('find_brands', { market: 'FR' });
  check(
    'ranking an unsupported market → supported list',
    !!unrankable.isError && /SE, NO, DK, FI, DE/.test(text(unrankable))
  );

  await client.close();

  // ── Excessive request rate ──
  if (withRate) {
    let limited = false;
    for (let i = 0; i < 200 && !limited; i += 1) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }),
      });
      if (res.status === 429) limited = true;
    }
    check('excessive request rate → 429', limited);
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
