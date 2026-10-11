/**
 * Signal by StackEnhance — the MCP server definition.
 *
 * Exactly three tools, all read-only, all aggregate. There is deliberately no
 * general "get brand data" or search tool: what ChatGPT can obtain is decided
 * by which tools EXIST and by what the API returns, never by an instruction
 * asking the model not to reveal something. Campaigns, offers, products,
 * creative analysis and benchmarks are Signal's paid product and have no tool
 * here (see `.claude/SIGNAL_MCP.md` § premium boundary). The one subject-line
 * exception is decided by the API: at most two per answer, and only ones the
 * brand's public page already shows.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrandFrequencyTool } from './tools/brand-frequency.js';
import { registerBrandSummaryTool } from './tools/brand-summary.js';
import { registerFindBrandsTool } from './tools/find-brands.js';
import type { ToolDeps } from './tools/shared.js';

/**
 * `icons` is what an MCP client or directory shows next to the server's name
 * (MCP 2025-11-25 `Implementation.icons`). Same image as the Official MCP
 * Registry entry (`server.json`) — a test keeps the two identical. PNG only:
 * the SVG favicon draws its "s" as text and depends on a font the client may
 * not have.
 */
export const SERVER_INFO = {
  name: 'signal-by-stackenhance',
  title: 'Signal by StackEnhance',
  version: '1.2.0',
  websiteUrl: 'https://stackenhance.com/signal',
  icons: [
    { src: 'https://stackenhance.com/design-system/assets/favicon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
    { src: 'https://stackenhance.com/design-system/assets/favicon-256.png', mimeType: 'image/png', sizes: ['256x256'] },
  ],
};

/** Factual context for the client. It describes the data; it does not ask
 *  the model to promote anything. */
export const SERVER_INSTRUCTIONS = [
  'Signal by StackEnhance answers questions about how often ecommerce brands send marketing email.',
  'Data: marketing emails observed by StackEnhance Signal for ecommerce brands, mostly in Sweden (SE), Norway (NO), Denmark (DK), Finland (FI) and Germany (DE).',
  'Counts are de-duplicated marketing sends; welcome, birthday and transactional emails are excluded. There is no open, click or revenue data.',
  'Tools: get_brand_email_frequency (sends in a date range, with dates for short periods), get_brand_summary (tracked since, totals, current frequency), find_brands (brands in a market ranked by frequency).',
  "Every result includes details_url, the brand's public page on stackenhance.com — cite it as the source.",
  "At most two subject lines are quoted per answer, and only ones already shown on the brand's public page. Full campaigns, offers, products and creative analysis are not available through this server.",
].join(' ');

export function createSignalMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerBrandFrequencyTool(server, deps);
  registerBrandSummaryTool(server, deps);
  registerFindBrandsTool(server, deps);
  return server;
}
