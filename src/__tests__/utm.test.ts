/**
 * details_url attribution — ONE helper (utm.ts), applied in api.ts to every
 * details_url the facts API returns, whatever the tool.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSignalApi } from '../api.js';
import { mcpClientSource, tagDetailsUrl } from '../utm.js';

const BASE = 'https://stackenhance.com/brands/newport-se';

describe('mcpClientSource', () => {
  it.each([
    ['openai-mcp/1.0.0', 'chatgpt'],
    ['ChatGPT-User/1.0', 'chatgpt'],
    ['Claude-User', 'claude'],
    ['Anthropic/ClaudeBot', 'claude'],
    ['Cursor/0.4', 'mcp'],
    [undefined, 'mcp'],
  ])('%s -> %s', (ua, expected) => {
    expect(mcpClientSource(ua)).toBe(expected);
  });
});

describe('tagDetailsUrl', () => {
  it('adds source (client), medium=mcp and campaign (tool)', () => {
    const u = new URL(tagDetailsUrl(BASE, { clientUserAgent: 'openai-mcp/1.0.0', tool: 'compare_brands' }));
    expect(u.origin + u.pathname).toBe(BASE);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      utm_source: 'chatgpt',
      utm_medium: 'mcp',
      utm_campaign: 'compare_brands',
    });
  });

  it('keeps an existing query, overwrites stale utm, and never throws on a bad URL', () => {
    const u = new URL(tagDetailsUrl(`${BASE}?lang=sv&utm_source=x`, { tool: 'find_brands' }));
    expect(u.searchParams.get('lang')).toBe('sv');
    expect(u.searchParams.get('utm_source')).toBe('mcp');
    expect(tagDetailsUrl('not a url', {})).toBe('not a url');
    expect(tagDetailsUrl('javascript:alert(1)', {})).toBe('javascript:alert(1)');
  });

  it('clips a hostile tool name to a safe campaign slug', () => {
    const u = new URL(tagDetailsUrl(BASE, { tool: 'x&utm_source=evil y' }));
    expect(u.searchParams.get('utm_campaign')).toBe('xutm_sourceevily');
  });
});

describe('createSignalApi tags every details_url it returns', () => {
  const CONFIG = { apiBaseUrl: 'https://api.example.test', mcpKey: undefined };
  const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const ctx = { tool: 'get_brand_summary', clientUserAgent: 'Claude-User' };
  const expectTagged = (url: string) => {
    const u = new URL(url);
    expect(u.searchParams.get('utm_source')).toBe('claude');
    expect(u.searchParams.get('utm_medium')).toBe('mcp');
    expect(u.searchParams.get('utm_campaign')).toBe('get_brand_summary');
  };

  it('lookup, frequency, summary and top-senders', async () => {
    const lookup = await createSignalApi(
      CONFIG,
      respond({ matches: [{ brand: 'N', slug: 'newport-se', details_url: BASE }] }) as never,
      ctx
    ).lookupBrand('Newport');
    expectTagged(lookup.matches[0].details_url);

    const freq = await createSignalApi(CONFIG, respond({ brand: 'N', details_url: BASE }) as never, ctx).emailFrequency(
      'newport-se',
      '2026-10-01',
      '2026-10-31'
    );
    expectTagged(freq.details_url);

    const summary = await createSignalApi(CONFIG, respond({ brand: 'N', details_url: BASE }) as never, ctx).summary(
      'newport-se'
    );
    expectTagged(summary.details_url);

    const top = await createSignalApi(
      CONFIG,
      respond({ market: 'SE', brands: [{ brand: 'N', emails_per_week: 2, details_url: BASE }] }) as never,
      ctx
    ).topSenders('SE');
    expectTagged(top.brands[0].details_url);
  });

  it('passes market_rank through, narrowed to rank/of/market', async () => {
    const summary = await createSignalApi(
      CONFIG,
      respond({ brand: 'N', details_url: BASE, market_rank: { rank: 4, of: 212, market: 'SE', secret: 1 } }) as never,
      ctx
    ).summary('newport-se');
    expect(summary.market_rank).toEqual({ rank: 4, of: 212, market: 'SE' });
    const bad = await createSignalApi(
      CONFIG,
      respond({ brand: 'N', details_url: BASE, market_rank: { rank: 'x' } }) as never,
      ctx
    ).summary('newport-se');
    expect(bad.market_rank).toBeNull();
  });
});
