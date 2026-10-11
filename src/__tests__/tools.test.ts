/**
 * The Signal MCP tools over an in-memory MCP connection, against a fake API.
 *
 * Pins: the tool surface (exactly three, read-only), the shape every result
 * carries, brand resolution (ambiguous / not tracked / wrong market), and that
 * a field the API should never have sent is dropped before it reaches ChatGPT.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSignalMcpServer } from '../server.js';
import { SignalApiError, type SignalApi } from '../api.js';

const NEWPORT_SE = {
  brand: 'Newport',
  market: 'SE',
  category: 'Home & Interior',
  slug: 'newport-se',
  details_url: 'https://stackenhance.com/brands/newport-se',
  exact: true,
};
const NEWPORT_DE = {
  ...NEWPORT_SE,
  market: 'DE',
  slug: 'newport-de',
  details_url: 'https://stackenhance.com/brands/newport-de',
};

const LAMP24 = {
  ...NEWPORT_SE,
  brand: 'Lamp24',
  slug: 'lamp24-se',
  details_url: 'https://stackenhance.com/brands/lamp24-se',
};
const LAMPEGIGANTEN = {
  ...NEWPORT_SE,
  brand: 'Lampegiganten',
  market: 'DK',
  slug: 'lampegiganten-dk',
  details_url: 'https://stackenhance.com/brands/lampegiganten-dk',
};

function fakeApi(overrides: Partial<SignalApi> = {}): SignalApi {
  return {
    lookupBrand: vi.fn(async (name: string, market?: string) =>
      name === 'Lamp'
        ? { matches: [LAMP24, LAMPEGIGANTEN], same_company: false }
        : market === 'SE'
          ? { matches: [NEWPORT_SE], same_company: true }
          : market
            ? { matches: [], available_markets: ['DE', 'SE'], same_company: false }
            : { matches: [NEWPORT_SE, NEWPORT_DE], same_company: true }
    ),
    emailFrequency: vi.fn(async (slug: string) => ({
      brand: 'Newport',
      market: slug === 'newport-de' ? 'DE' : 'SE',
      period: '2026-08',
      emails_sent: slug === 'newport-de' ? 6 : 11,
      average_per_week: slug === 'newport-de' ? 1.4 : 2.5,
      tracked_since: '2019-01-01',
      details_url: `https://stackenhance.com/brands/${slug}`,
    })),
    summary: vi.fn(async () => ({
      brand: 'Newport',
      market: 'SE',
      category: 'Home & Interior',
      tracked_since: '2019-01-01',
      total_observed_emails: 995,
      current_emails_per_week: 2.4,
      latest_observed_campaign_date: '2026-10-01',
      details_url: 'https://stackenhance.com/brands/newport-se',
    })),
    topSenders: vi.fn(async () => ({
      market: 'SE',
      category: null,
      window_days: 90,
      brands_tracked: 359,
      brands: [
        {
          brand: 'Boozt.com',
          category: 'Fashion & Apparel',
          emails_per_week: 8.5,
          details_url: 'https://stackenhance.com/brands/boozt-com-se',
        },
      ],
    })),
    ...overrides,
  };
}

async function connect(api: SignalApi) {
  const server = createSignalMcpServer({ api, log: () => {} });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Result = { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
const textOf = (r: Result) => r.content.map((c) => c.text ?? '').join('\n');

describe('server identity', () => {
  it("advertises the registry entry's icon, so clients and directories can show it", async () => {
    const client = await connect(fakeApi());
    const info = client.getServerVersion() as { icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }> };
    const registry = JSON.parse(readFileSync(new URL('../../server.json', import.meta.url), 'utf8')) as {
      icons: Array<{ src: string; mimeType: string; sizes: string[] }>;
    };
    expect(info.icons?.length).toBeGreaterThan(0);
    for (const icon of info.icons ?? []) {
      expect(icon.src).toMatch(/^https:\/\/stackenhance\.com\/.+\.png$/);
      expect(icon.mimeType).toBe('image/png');
    }
    // The registry's icon is one of the server's own, byte for byte.
    expect(info.icons).toContainEqual(registry.icons[0]);
  });
});

describe('tool surface', () => {
  it('exposes exactly the three read-only aggregate tools', async () => {
    const client = await connect(fakeApi());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['find_brands', 'get_brand_email_frequency', 'get_brand_summary']);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.outputSchema).toBeDefined();
      // OpenAI Apps SDK: callable anonymously; status lines within the platform's 64-char limit.
      expect(t._meta?.securitySchemes).toEqual([{ type: 'noauth' }]);
      for (const key of ['openai/toolInvocation/invoking', 'openai/toolInvocation/invoked']) {
        const text = t._meta?.[key] as string;
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('get_brand_email_frequency', () => {
  it('answers with the fact, a sentence, the source and the brand page', async () => {
    const api = fakeApi();
    const client = await connect(api);
    const r = (await client.callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'SE', from: '2026-08-01', to: '2026-08-31' },
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      results: [{ emails_sent: 11, details_url: 'https://stackenhance.com/brands/newport-se' }],
    });
    expect(textOf(r)).toContain('Newport (SE) sent 11 marketing emails, about 2.5 per week in August 2026');
    expect(textOf(r)).toContain(
      'The full campaigns (previews, offers, timing, AI analysis) are in StackEnhance Signal → https://stackenhance.com/brands/newport-se'
    );
    expect(api.emailFrequency).toHaveBeenCalledWith('newport-se', '2026-08-01', '2026-08-31');
  });

  it('answers the Definition-of-Done question with one figure per market of ONE company', async () => {
    const api = fakeApi();
    const client = await connect(api);
    const r = (await client.callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', from: '2026-08-01', to: '2026-08-31' },
    })) as Result;
    expect(r.isError).toBeFalsy();
    const results = (r.structuredContent?.results ?? []) as Array<Record<string, unknown>>;
    expect(results.map((x) => [x.market, x.emails_sent])).toEqual([
      ['DE', 6],
      ['SE', 11],
    ]);
    expect(textOf(r)).toContain('Newport marketing emails in August 2026, by market');
    expect(textOf(r)).toContain('- Newport (DE): 6 marketing emails, about 1.4 per week');
  });

  const LAST_WEEK = {
    brand: 'Newport',
    market: 'SE',
    period: '2026-09-28/2026-10-04',
    emails_sent: 4,
    send_dates: ['2026-09-30', '2026-10-02', '2026-10-02', '2026-10-04'],
    average_per_week: 4,
    tracked_since: '2019-01-01',
    public_subjects: [
      { subject: '20% på belysning i helgen', date: '2026-10-04' },
      { subject: 'Höstens nyheter är här', date: '2026-10-02' },
    ],
    details_url: 'https://stackenhance.com/brands/newport-se',
  };
  const callWeek = async (fact: Record<string, unknown>) =>
    (await (
      await connect(fakeApi({ emailFrequency: vi.fn(async () => fact) as never }))
    ).callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'SE', from: '2026-09-28', to: '2026-10-04' },
    })) as Result;

  it('answers "what did Newport send last week?" with dates, two public subjects and the brand page', async () => {
    const r = await callWeek(LAST_WEEK);
    expect(r.isError).toBeFalsy();
    const lines = textOf(r).split('\n\n')[0].split('\n');
    expect(lines[0]).toBe(
      'Newport (SE) sent 4 marketing emails, about 4 per week in 2026-09-28 to 2026-10-04: Wed 30 Sep, Fri 2 Oct (2 emails), Sun 4 Oct.'
    );
    expect(lines[1]).toBe('Latest two: "20% på belysning i helgen" · "Höstens nyheter är här"');
    expect(lines.at(-1)).toBe(
      'The full campaigns (previews, offers, timing, AI analysis) are in StackEnhance Signal → https://stackenhance.com/brands/newport-se'
    );
    expect(r.structuredContent).toMatchObject({ results: [{ send_dates: LAST_WEEK.send_dates }] });
  });

  it('says a send without a quoted subject was CAPTURED — its subject is in Signal, not missing', async () => {
    // Live 2026-10-09: Mio sent 3 in a week, two subjects quoted; ChatGPT rendered
    // "Subject line not available" for the third and guessed at a capture failure.
    const r = await callWeek(LAST_WEEK);
    const lines = textOf(r).split('\n\n')[0].split('\n');
    expect(lines[2]).toBe(
      'The subject lines of the other 2 sends (Wed 30 Sep, Fri 2 Oct) were captured too and are in StackEnhance Signal — this app quotes at most two, and only ones already on the brand’s public page.'
    );
    expect(r.structuredContent).toMatchObject({
      results: [{ sends_with_subject_in_signal: { count: 2, dates: ['2026-09-30', '2026-10-02'] } }],
    });
  });

  it('names no withheld send when every listed send has its subject quoted', async () => {
    const r = await callWeek({
      ...LAST_WEEK,
      emails_sent: 2,
      send_dates: ['2026-10-02', '2026-10-04'],
    });
    expect(textOf(r)).not.toContain('captured too');
    expect((r.structuredContent as { results: object[] }).results[0]).not.toHaveProperty(
      'sends_with_subject_in_signal'
    );
  });

  it('gives count + dates only when no public subject falls in the period', async () => {
    const r = await callWeek({ ...LAST_WEEK, public_subjects: [] });
    const t = textOf(r).split('\n\n')[0];
    expect(t).toContain('Wed 30 Sep, Fri 2 Oct (2 emails), Sun 4 Oct.');
    expect(t).not.toContain('Latest');
    expect(t).toMatch(/StackEnhance Signal → https:\/\/stackenhance\.com\/brands\/newport-se$/);
  });

  it('gives the count without dates for a long period', async () => {
    const { send_dates: _d, ...noDates } = LAST_WEEK;
    const r = await callWeek({
      ...noDates,
      period: '2025',
      emails_sent: 120,
      average_per_week: 2.3,
      public_subjects: [],
    });
    const t = textOf(r).split('\n\n')[0];
    expect(t.split('\n')[0]).toBe('Newport (SE) sent 120 marketing emails, about 2.3 per week in 2025.');
    expect(t).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);
    expect(t).toMatch(/StackEnhance Signal → https:\/\/stackenhance\.com\/brands\/newport-se$/);
  });

  it('describes the "last week" use and the public-subject limit', async () => {
    const { tools } = await (await connect(fakeApi())).listTools();
    const d = tools.find((t) => t.name === 'get_brand_email_frequency')?.description ?? '';
    expect(d).toContain('What did Newport send last week?');
    expect(d).toContain('"last week" is the previous Monday–Sunday');
    expect(d).toContain('at most two subject lines');
  });

  it('words a zero as an observation, never "sent 0"', async () => {
    const api = fakeApi({
      emailFrequency: vi.fn(async () => ({
        brand: 'IKEA',
        market: 'SE',
        period: '2026-08',
        emails_sent: 0,
        average_per_week: 0,
        tracked_since: '2020-03-31',
        details_url: 'https://stackenhance.com/brands/ikea-se',
        note: "Signal's latest observed email from this brand is dated 2026-03-16.",
      })),
    });
    const r = (await (
      await connect(api)
    ).callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'SE', from: '2026-08-01', to: '2026-08-31' },
    })) as Result;
    expect(textOf(r)).toContain('Signal observed no marketing emails from IKEA (SE) in August 2026.');
    expect(textOf(r)).not.toMatch(/sent 0|about 0/);
  });

  it('asks for a market when the name matches DIFFERENT companies', async () => {
    const client = await connect(fakeApi());
    const r = (await client.callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Lamp', from: '2026-08-01', to: '2026-08-31' },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Call again with `market`/);
    expect(textOf(r)).toContain('Lampegiganten (DK)');
  });

  it('reports a market that cannot answer beside the ones that can', async () => {
    const api = fakeApi({
      emailFrequency: vi.fn(async (slug: string) => {
        if (slug === 'newport-de') {
          throw new SignalApiError(422, 'before_tracking', 'The period ends before Signal began observing this brand.');
        }
        return {
          brand: 'Newport',
          market: 'SE',
          period: '2026-01',
          emails_sent: 9,
          average_per_week: 2,
          tracked_since: '2019-01-01',
          details_url: 'https://stackenhance.com/brands/newport-se',
        };
      }),
    });
    const r = (await (
      await connect(api)
    ).callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', from: '2026-01-01', to: '2026-01-31' },
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.unavailable).toEqual([
      { brand: 'Newport', market: 'DE', reason: 'The period ends before Signal began observing this brand.' },
    ]);
  });

  it('names the markets a brand IS tracked in when the asked one is wrong', async () => {
    const client = await connect(fakeApi());
    const r = (await client.callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'NO', from: '2026-08-01', to: '2026-08-31' },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Tracked markets for this brand: DE, SE');
  });

  it('relays an API validation message and explains a rate limit', async () => {
    const bad = fakeApi({
      emailFrequency: vi.fn(async () => {
        throw new SignalApiError(
          400,
          'invalid_date',
          '`from` and `to` must both be real calendar dates in YYYY-MM-DD format.'
        );
      }),
    });
    const r1 = (await (
      await connect(bad)
    ).callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'SE', from: '2026-02-30', to: '2026-03-01' },
    })) as Result;
    expect(textOf(r1)).toContain('real calendar dates');

    const limited = fakeApi({
      emailFrequency: vi.fn(async () => {
        throw new SignalApiError(429, undefined, 'Too Many Requests');
      }),
    });
    const r2 = (await (
      await connect(limited)
    ).callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'SE', from: '2026-08-01', to: '2026-08-31' },
    })) as Result;
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toContain('rate-limited');
  });

  it('rejects a malformed date at the schema, before any API call', async () => {
    const api = fakeApi();
    const client = await connect(api);
    const r = (await client.callTool({
      name: 'get_brand_email_frequency',
      arguments: { brand: 'Newport', market: 'SE', from: 'August', to: '2026-08-31' },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(api.lookupBrand).not.toHaveBeenCalled();
  });
});

describe('get_brand_summary and find_brands', () => {
  it('summarises without any campaign-level field', async () => {
    const client = await connect(fakeApi());
    const r = (await client.callTool({
      name: 'get_brand_summary',
      arguments: { brand: 'Newport', market: 'SE' },
    })) as Result;
    const results = (r.structuredContent?.results ?? []) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]).sort()).toEqual(
      [
        'brand',
        'category',
        'current_emails_per_week',
        'details_url',
        'latest_observed_campaign_date',
        'market',
        'total_observed_emails',
        'tracked_since',
      ].sort()
    );
  });

  it('states a dormant brand as what Signal SAW, never "0 emails per week"', async () => {
    const api = fakeApi({
      summary: vi.fn(async () => ({
        brand: 'IKEA',
        market: 'SE',
        category: 'Home & Interior',
        tracked_since: '2020-03-31',
        total_observed_emails: 45,
        current_emails_per_week: 0,
        latest_observed_campaign_date: '2026-03-16',
        details_url: 'https://stackenhance.com/brands/ikea-se',
      })),
    });
    const r = (await (
      await connect(api)
    ).callTool({ name: 'get_brand_summary', arguments: { brand: 'IKEA', market: 'SE' } })) as Result;
    expect(textOf(r)).toContain('no marketing emails observed in the last 90 days; the latest is dated 2026-03-16');
    expect(textOf(r)).not.toMatch(/about 0/);
  });

  it('ranks a market', async () => {
    const client = await connect(fakeApi());
    const r = (await client.callTool({ name: 'find_brands', arguments: { market: 'SE', limit: 3 } })) as Result;
    expect(textOf(r)).toContain('1. Boozt.com — 8.5 emails/week');
    expect(r.structuredContent).toMatchObject({ brands_tracked: 359 });
  });
});
