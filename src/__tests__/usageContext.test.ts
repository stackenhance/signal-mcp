/**
 * Usage context — what the MCP tells the backend about each request so the
 * admin `/admin/signal-mcp` page can count tool calls by tool and by client.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createSignalApi } from '../api.js';
import { callContext } from '../http.js';

const CONFIG = { apiBaseUrl: 'https://api.example.test', mcpKey: 'k'.repeat(40) };

function req(body: unknown, headers: Record<string, string> = {}) {
  return { body, headers } as unknown as IncomingMessage & { body?: unknown };
}

describe('callContext', () => {
  it('names the tool a tools/call invokes, mints a call id, and keeps the client UA', () => {
    const ctx = callContext(
      req(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_brand_summary', arguments: {} } },
        { 'user-agent': 'openai-mcp/1.0.0' }
      )
    );
    expect(ctx.tool).toBe('get_brand_summary');
    expect(ctx.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.clientUserAgent).toBe('openai-mcp/1.0.0');
  });

  it('gives every request its own call id', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_brands' } };
    expect(callContext(req(body)).callId).not.toBe(callContext(req(body)).callId);
  });

  it('has no tool or call id for methods that are not a tool call', () => {
    const ctx = callContext(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'user-agent': 'Claude-User' }));
    expect(ctx).toEqual({ clientUserAgent: 'Claude-User' });
  });
});

describe('createSignalApi usage headers', () => {
  it('sends tool, call id and client UA on every facts request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    await createSignalApi(CONFIG, fetchImpl as unknown as typeof fetch, {
      tool: 'get_brand_summary',
      callId: '6f1c2a4e-1111-4222-8333-444455556666',
      clientUserAgent: 'Claude-User',
    }).lookupBrand('Newport');
    const headers = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Record<string, string>;
    expect(headers['X-Signal-Tool']).toBe('get_brand_summary');
    expect(headers['X-Signal-Call-Id']).toBe('6f1c2a4e-1111-4222-8333-444455556666');
    expect(headers['X-Signal-Client-UA']).toBe('Claude-User');
  });

  it('strips characters fetch would throw on, so a strange UA never fails the tool call', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    await createSignalApi(CONFIG, fetchImpl as unknown as typeof fetch, {
      clientUserAgent: 'Bot\r\nX-Evil: 1 ☃ åäö',
    }).lookupBrand('Newport');
    const headers = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Record<string, string>;
    expect(headers['X-Signal-Client-UA']).toBe('BotX-Evil: 1  ');
  });

  it('sends no usage headers without a context (direct use of the client)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    await createSignalApi(CONFIG, fetchImpl as unknown as typeof fetch).lookupBrand('Newport');
    const headers = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Record<string, string>;
    expect(Object.keys(headers).filter((h) => h.startsWith('X-Signal-') && h !== 'X-Signal-Mcp-Key')).toEqual([]);
  });
});
