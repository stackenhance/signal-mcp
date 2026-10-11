/**
 * HTTP entry for the Signal MCP server — Streamable HTTP, STATELESS.
 *
 * Each POST builds a fresh server + transport and answers with plain JSON
 * (`enableJsonResponse`), so the handler runs unchanged on a serverless
 * function (`api/mcp.ts` on Vercel) and on the local dev server (`dev.ts`).
 * There are no sessions, so GET (the SSE stream) and DELETE (session end)
 * answer 405, as the spec prescribes for a server without them.
 *
 * Abuse protection is layered: a small per-instance, per-IP cap here (cheap,
 * imperfect on serverless — instances do not share memory), and the real
 * limit on the backend, where every tool call becomes a rate-limited request.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSignalApi, type SignalCallContext } from './api.js';
import type { SignalMcpConfig } from './config.js';
import { createSignalMcpServer } from './server.js';
import { defaultLog } from './tools/shared.js';

const LOCAL_LIMIT = 120; // requests per minute per client IP, per instance
const WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

function overLocalLimit(ip: string, now = Date.now()): boolean {
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOCAL_LIMIT;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function setCors(res: ServerResponse): void {
  // Public, read-only, credential-free: any origin may call it (browser-based
  // MCP inspectors need this; ChatGPT calls server-to-server).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function rpcMethods(body: unknown): string[] {
  const list = Array.isArray(body) ? body : [body];
  return list.map((m) =>
    m && typeof m === 'object' && 'method' in m ? String((m as { method: unknown }).method) : '?'
  );
}

/**
 * The usage context for this request: the tool a `tools/call` names, a fresh
 * call id, and the calling client's User-Agent. Sent to the backend with every
 * facts request (see `SignalCallContext`). Other methods (initialize,
 * tools/list) make no facts request, so they need no tool.
 */
export function callContext(req: IncomingMessage & { body?: unknown }): SignalCallContext {
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  const tool = body?.method === 'tools/call' && typeof body.params?.name === 'string' ? body.params.name : undefined;
  const ua = req.headers['user-agent'];
  return {
    ...(tool ? { tool, callId: randomUUID() } : {}),
    ...(typeof ua === 'string' && ua ? { clientUserAgent: ua } : {}),
  };
}

export async function handleMcpHttp(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  config: SignalMcpConfig
): Promise<void> {
  setCors(res);
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendJson(
      res,
      405,
      jsonRpcError(-32000, 'Method not allowed. This MCP server is stateless: POST JSON-RPC to this URL.'),
      {
        Allow: 'POST, OPTIONS',
      }
    );
    return;
  }

  const ip = clientIp(req);
  if (overLocalLimit(ip)) {
    defaultLog({ evt: 'mcp_rate_limited', ip });
    sendJson(res, 429, jsonRpcError(-32000, 'Too many requests. Please slow down.'), { 'Retry-After': '60' });
    return;
  }

  // One JSON-RPC message per POST. The SDK accepts batches of up to 100, and a
  // batch counted as ONE request here: a single anonymous POST with 100 ×
  // get_brand_summary made ~700 backend calls and emptied the bucket every
  // ChatGPT user on that Vercel egress IP shares (reproduced 2026-10-02).
  // ChatGPT sends single messages (the 2025-06-18 spec dropped batching).
  if (Array.isArray(req.body)) {
    defaultLog({ evt: 'mcp_batch_rejected', ip, size: req.body.length });
    sendJson(
      res,
      400,
      jsonRpcError(-32600, 'Batch requests are not supported. Send one JSON-RPC message per request.')
    );
    return;
  }

  const started = Date.now();
  const context = callContext(req);
  const server = createSignalMcpServer({ api: createSignalApi(config, fetch, context) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    defaultLog({
      evt: 'mcp_request',
      methods: rpcMethods(req.body),
      tool: context.tool,
      ua: context.clientUserAgent?.slice(0, 120),
      status: res.statusCode,
      ms: Date.now() - started,
    });
  } catch (error) {
    defaultLog({ evt: 'mcp_error', error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) sendJson(res, 500, jsonRpcError(-32603, 'Internal server error'));
  }
}
