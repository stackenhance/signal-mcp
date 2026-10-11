/**
 * The Signal API client — the MCP server's only data source.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSignalApi, SignalApiError } from '../api.js';
import { loadConfig } from '../config.js';

function respond(status: number, body: unknown) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

const CONFIG = { apiBaseUrl: 'https://api.example.test', mcpKey: 'k'.repeat(40) };

describe('createSignalApi', () => {
  it('builds the narrow URL, sends the MCP key, and refuses redirects', async () => {
    const fetchImpl = respond(200, { brand: 'Newport' });
    await createSignalApi(CONFIG, fetchImpl as unknown as typeof fetch).emailFrequency(
      'newport-se',
      '2026-08-01',
      '2026-08-31'
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.example.test/api/public/brands/newport-se/email-frequency?from=2026-08-01&to=2026-08-31'
    );
    expect((init?.headers as Record<string, string>)['X-Signal-Mcp-Key']).toBe(CONFIG.mcpKey);
    expect(init?.redirect).toBe('error');
  });

  it('drops any field outside the allow-list, even if the API sent it', async () => {
    const leaky = respond(200, {
      brand: 'Newport',
      market: 'SE',
      period: '2026-08',
      emails_sent: 11,
      average_per_week: 2.5,
      tracked_since: '2019-01-01',
      details_url: 'https://stackenhance.com/brands/newport-se',
      subjects: ['Höstrea — 30% på allt'],
      id: '84793d17',
    });
    const fact = await createSignalApi(CONFIG, leaky as unknown as typeof fetch).emailFrequency(
      'newport-se',
      '2026-08-01',
      '2026-08-31'
    );
    expect(fact).not.toHaveProperty('subjects');
    expect(fact).not.toHaveProperty('id');
    expect(fact.emails_sent).toBe(11);
  });

  it('narrows the nested public_subjects too: subject + date only, at most two', async () => {
    const leaky = respond(200, {
      brand: 'Newport',
      emails_sent: 3,
      send_dates: ['2026-10-02', 7, '2026-10-04'],
      public_subjects: [
        { subject: 'A', date: '2026-10-04', html: '<p>x</p>', healthScore: 90 },
        { subject: 'B', date: '2026-10-02' },
        { subject: 'C', date: '2026-10-01' },
        { subject: 42, date: '2026-10-01' },
      ],
    });
    const fact = await createSignalApi(CONFIG, leaky as unknown as typeof fetch).emailFrequency(
      'newport-se',
      '2026-09-28',
      '2026-10-04'
    );
    expect(fact.public_subjects).toEqual([
      { subject: 'A', date: '2026-10-04' },
      { subject: 'B', date: '2026-10-02' },
    ]);
    expect(fact.send_dates).toEqual(['2026-10-02', '2026-10-04']);
  });

  it('turns an error response into a SignalApiError with its code', async () => {
    const api = createSignalApi(
      CONFIG,
      respond(422, { error: 'The period starts after today.', code: 'period_in_future' }) as never
    );
    await expect(api.emailFrequency('newport-se', '2030-01-01', '2030-01-31')).rejects.toMatchObject({
      status: 422,
      code: 'period_in_future',
      message: 'The period starts after today.',
    });
  });

  it('reports a network failure without leaking internals', async () => {
    const api = createSignalApi(
      CONFIG,
      vi.fn(async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND internal-host');
      }) as never
    );
    const err = await api.summary('newport-se').catch((e) => e);
    expect(err).toBeInstanceOf(SignalApiError);
    expect(err.message).toBe('Signal API unreachable');
  });
});

describe('loadConfig', () => {
  it('defaults to production and treats an empty key as unset', () => {
    expect(loadConfig({})).toEqual({
      apiBaseUrl: 'https://stackenhance-backend-production.up.railway.app',
      mcpKey: undefined,
    });
    expect(loadConfig({ SIGNAL_MCP_KEY: '  ' }).mcpKey).toBeUndefined();
  });

  it('refuses a plain-http remote API URL', () => {
    expect(() => loadConfig({ SIGNAL_API_URL: 'http://evil.example' })).toThrow(/https/);
    expect(loadConfig({ SIGNAL_API_URL: 'http://localhost:3000/' }).apiBaseUrl).toBe('http://localhost:3000');
  });
});
