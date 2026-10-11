/**
 * Runtime configuration for the Signal MCP server.
 *
 * The server holds NO database credentials by construction: its only data
 * source is the public Signal facts API on the backend. Two settings:
 *
 *   SIGNAL_API_URL  base URL of that API (defaults to production)
 *   SIGNAL_MCP_KEY  optional shared key — puts this server on its own
 *                   rate-limit tier on the backend; never required
 */

export const DEFAULT_SIGNAL_API_URL = 'https://stackenhance-backend-production.up.railway.app';

export interface SignalMcpConfig {
  apiBaseUrl: string;
  mcpKey: string | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SignalMcpConfig {
  const raw = (env.SIGNAL_API_URL || DEFAULT_SIGNAL_API_URL).trim().replace(/\/+$/, '');
  const url = new URL(raw); // throws on garbage: fail at startup, not per request
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`SIGNAL_API_URL must be https (got ${url.protocol})`);
  }
  const key = env.SIGNAL_MCP_KEY?.trim();
  return { apiBaseUrl: raw, mcpKey: key ? key : undefined };
}
