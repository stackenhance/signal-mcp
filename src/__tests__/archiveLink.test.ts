/**
 * The "full archive" link in the tool TEXT (owner decision 2026-10-30): a
 * tagged `/full-archive/<slug>` URL that /admin/activity counts per surface and
 * brand. Pinned through the real tools over an MCP connection (the wiring, not
 * only the helper — L35), and that the STRUCTURED output gains no field.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSignalMcpServer } from '../server.js';
import { SignalApiError, type SignalApi } from '../api.js';
import { archiveUrl } from '../tools/shared.js';

const SE = {
  brand: 'Newport',
  market: 'SE',
  category: 'Home & Interior',
  slug: 'newport-se',
  details_url: 'https://stackenhance.com/brands/newport-se',
  exact: true,
};
const DE = { ...SE, market: 'DE', slug: 'newport-de', details_url: 'https://stackenhance.com/brands/newport-de' };

function api(overrides: Partial<SignalApi> = {}): SignalApi {
  return {
    lookupBrand: vi.fn(async (_n: string, market?: string) =>
      market === 'SE' ? { matches: [SE], same_company: true } : { matches: [SE, DE], same_company: true }
    ),
    emailFrequency: vi.fn(async (slug: string) => ({
      brand: 'Newport',
      market: slug === 'newport-de' ? 'DE' : 'SE',
      period: '2026-08',
      emails_sent: 11,
      average_per_week: 2.5,
      tracked_since: '2019-01-01',
      details_url: `https://stackenhance.com/brands/${slug}`,
    })),
    summary: vi.fn(async (slug: string) => ({
      brand: 'Newport',
      market: slug === 'newport-de' ? 'DE' : 'SE',
      category: 'Home & Interior',
      tracked_since: '2019-01-01',
      total_observed_emails: 120,
      current_emails_per_week: 2.4,
      latest_observed_campaign_date: '2026-10-01',
      details_url: `https://stackenhance.com/brands/${slug}`,
    })),
    topSenders: vi.fn(),
    ...overrides,
  } as SignalApi;
}

async function call(a: SignalApi, name: string, args: Record<string, unknown>) {
  const server = createSignalMcpServer({ api: a, log: () => {} });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
    structuredContent?: { results?: Array<Record<string, unknown>> };
  };
}
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');

const SE_SUMMARY =
  'https://stackenhance.com/full-archive/newport-se?utm_source=signal-mcp&utm_medium=ai-assistant&utm_campaign=full-archive&utm_content=summary';

describe('archiveUrl', () => {
  it('names the brand in the PATH and the surface in the tags', () => {
    expect(archiveUrl(SE.details_url, 'summary')).toBe(SE_SUMMARY);
  });
  it('gives no link for an address it cannot read', () => {
    expect(archiveUrl('not a url', 'summary')).toBeNull();
    expect(archiveUrl('https://stackenhance.com/', 'summary')).toBeNull();
  });
});

describe('the archive link in tool text', () => {
  it('get_brand_summary states the archive since tracked_since, with the tagged link', async () => {
    const r = await call(api(), 'get_brand_summary', { brand: 'Newport', market: 'SE' });
    expect(text(r)).toContain(`Full archive since 2019-01-01 (`);
    expect(text(r)).toContain(`→ ${SE_SUMMARY}`);
    // The reviewed structured output is untouched.
    expect(Object.keys(r.structuredContent?.results?.[0] ?? {})).not.toContain('archive_url');
    expect(JSON.stringify(r.structuredContent)).not.toContain('full-archive');
  });

  it('a summary across markets links every market', async () => {
    const r = await call(api(), 'get_brand_summary', { brand: 'Newport' });
    expect(text(r)).toContain('/full-archive/newport-se?');
    expect(text(r)).toContain('/full-archive/newport-de?');
  });

  it('get_brand_email_frequency links the archive, tagged as the frequency tool', async () => {
    const r = await call(api(), 'get_brand_email_frequency', {
      brand: 'Newport',
      market: 'SE',
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(text(r)).toContain('/full-archive/newport-se?utm_source=signal-mcp');
    expect(text(r)).toContain('utm_content=frequency');
    expect(JSON.stringify(r.structuredContent)).not.toContain('full-archive');
  });

  it('a period older than six months answers with where the archive is', async () => {
    const tooOld = api({
      emailFrequency: vi.fn(async () => {
        throw new SignalApiError(400, 'range_too_old', 'The period must start within the last six months.');
      }),
    });
    const r = await call(tooOld, 'get_brand_email_frequency', {
      brand: 'Newport',
      market: 'SE',
      from: '2024-01-01',
      to: '2024-01-31',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('within the last six months');
    expect(text(r)).toContain('/full-archive/newport-se?');
  });

  it('any other error gets no archive link', async () => {
    const limited = api({
      emailFrequency: vi.fn(async () => {
        throw new SignalApiError(429, undefined, 'Too Many Requests');
      }),
    });
    const r = await call(limited, 'get_brand_email_frequency', {
      brand: 'Newport',
      market: 'SE',
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(text(r)).not.toContain('full-archive');
  });
});
