/**
 * Local dev server: the same handler Vercel runs, on http://localhost:3333/mcp.
 *
 *   npm --prefix signal-mcp run dev
 *   SIGNAL_API_URL=http://localhost:3000 npm --prefix signal-mcp run dev   # against a local backend
 *
 * Parses JSON bodies the way Vercel does (`req.body`) before handing over.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { loadConfig } from './config.js';
import { handleMcpHttp } from './http.js';

const PORT = Number(process.env.PORT || 3333);
const config = loadConfig();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

createServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  const body = req.method === 'POST' ? await readJson(req) : undefined;
  await handleMcpHttp(Object.assign(req, { body }), res, config);
}).listen(PORT, () => {
  console.log(`signal-mcp listening on http://localhost:${PORT}/mcp → ${config.apiBaseUrl}`);
});
