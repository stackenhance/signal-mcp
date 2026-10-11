/**
 * The HTTP entry (`handleMcpHttp`) — what Vercel's `api/mcp.ts` runs. A real
 * node:http server on an ephemeral port; tools/list needs no backend call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleMcpHttp } from '../http.js';

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    await handleMcpHttp(Object.assign(req, { body }), res, {
      apiBaseUrl: 'https://api.example.test',
      mcpKey: undefined,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

describe('handleMcpHttp', () => {
  it('answers tools/list statelessly with plain JSON', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'x-real-ip': '198.51.100.1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      'find_brands',
      'get_brand_email_frequency',
      'get_brand_summary',
    ]);
  });

  it('refuses a JSON-RPC batch — 100 calls must not ride on one rate-limit token', async () => {
    const one = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const res = await rpc([one, { ...one, id: 2 }], { 'x-real-ip': '198.51.100.9' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/batch/i);
  });

  it('refuses GET (no SSE sessions) and answers CORS preflight', async () => {
    expect((await fetch(url)).status).toBe(405);
    const pre = await fetch(url, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rate-limits a single client that bursts', async () => {
    let limited = 0;
    for (let i = 0; i < 125; i += 1) {
      const res = await rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' }, { 'x-real-ip': '203.0.113.99' });
      if (res.status === 429) limited += 1;
      else await res.text();
    }
    expect(limited).toBeGreaterThan(0);
    // …and only that client: another IP is unaffected.
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'x-real-ip': '203.0.113.100' })).status).toBe(
      200
    );
  }, 30_000); // 126 sequential requests; the 5 s default fails on a loaded machine
});
