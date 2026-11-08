/**
 * UTM tagging of `details_url` — ONE helper, applied in `api.ts` to every
 * `details_url` the facts API returns, so every tool (and every field a model
 * may cite) carries the same attribution. Without it the visit from an answer
 * is anonymous (ChatGPT often sends no referrer, Claude's desktop app none).
 *
 *   utm_source   = the AI client: chatgpt | claude | mcp (anything else)
 *   utm_medium   = mcp
 *   utm_campaign = the tool that produced the answer
 *
 * Only `details_url` is tagged. Canonical URLs elsewhere (sitemaps, the site's
 * own links, the `/full-archive` link, which has its own `utm_*` for the
 * archive-interest report) are untouched. The backend's channel classifier
 * (`siteAnalytics/channel.ts`) files `utm_medium=mcp` under "AI assistants".
 * Twin of `classifySignalClient` in the backend (a different package; the
 * client names are pinned by `utm.test.ts`).
 */

export type McpClientSource = 'chatgpt' | 'claude' | 'mcp';

export function mcpClientSource(userAgent: string | undefined): McpClientSource {
  const ua = userAgent?.trim() ?? '';
  if (/openai|chatgpt/i.test(ua)) return 'chatgpt';
  if (/claude|anthropic/i.test(ua)) return 'claude';
  return 'mcp';
}

/** `utm_campaign` is a tool name; anything else is clipped to a safe slug. */
function campaign(tool: string | undefined): string {
  const t = (tool ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
  return t || 'mcp';
}

/**
 * Add the three parameters to an absolute http(s) URL. Anything that is not
 * one is returned unchanged (never throw inside a tool call for telemetry).
 */
export function tagDetailsUrl(url: string, ctx: { clientUserAgent?: string; tool?: string }): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
    u.searchParams.set('utm_source', mcpClientSource(ctx.clientUserAgent));
    u.searchParams.set('utm_medium', 'mcp');
    u.searchParams.set('utm_campaign', campaign(ctx.tool));
    return u.toString();
  } catch {
    return url;
  }
}
