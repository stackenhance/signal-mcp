# Signal by StackEnhance — MCP server

**Marketing-email intelligence for e-commerce brands in the Nordics and Germany, inside your AI assistant.**

Signal by StackEnhance is a free, read-only [Model Context Protocol](https://modelcontextprotocol.io) server. It lets Claude, ChatGPT, Cursor and other MCP clients answer questions about how often online stores send marketing email, and when, from the archive behind [StackEnhance Signal](https://stackenhance.com/signal).

```
https://mcp.stackenhance.com/mcp
```

Streamable HTTP · no API key · no sign-in · read-only · free

## What you can ask

- *How often does Boozt email its customers in Sweden?*
- *What did Newport send last week?*
- *How many emails did IKEA send in August?*
- *Which home and interior brands in Denmark email most often?*
- *Is Gina Tricot still sending newsletters?*

Every answer links to the brand's public page on stackenhance.com as its source.

## The data

|                    |                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **Brands**         | 750+ online stores, mostly in Sweden, Norway, Denmark, Finland and Germany                            |
| **Emails**         | 75,000+ marketing emails captured                                                                     |
| **What counts**    | De-duplicated campaign sends. Welcome, birthday and transactional emails are excluded.                |
| **Frequency**      | Average marketing emails per week over the last 90 days                                               |
| **Dates**          | The brand's local calendar date                                                                       |
| **Not available**  | Open, click or revenue data (Signal has none), full campaigns, offers, products and creative analysis |

For a period of up to 31 days the server lists the date of each send. It may quote up to two subject lines, and only ones already shown on the brand's public page.

## Tools

| Tool                        | Answers                                                                                                            | Inputs                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `get_brand_summary`         | A brand's profile: market, category, first observed, total emails, current emails per week, latest campaign date   | `brand`, optional `market`                                                 |
| `get_brand_email_frequency` | How many marketing emails a brand sent in a period, and on which days (periods up to 31 days)                      | `brand`, `from`, `to` (YYYY-MM-DD, up to two years), optional `market`     |
| `find_brands`               | Brands in one market ranked by current email frequency, optionally within a category                                | `market` (SE, NO, DK, FI, DE), optional `category`, `limit` (1–10)          |

All three are read-only and idempotent. A brand can be given by name (`Newport`) or domain (`newport.se`). Without a `market`, a brand sold in several countries returns one result per market.

## Setup

### Claude (web, desktop and mobile)

Open **[Signal by StackEnhance in Claude's directory](https://claude.ai/directory/signal-by-stackenhance)** and click **Connect**.

Or add it by hand: **Settings → Connectors → Add custom connector**, name it `Signal by StackEnhance`, paste the server URL and leave the OAuth fields empty.

### ChatGPT

1. Open **Settings → Apps & Connectors → Advanced** and turn on **Developer mode**.
2. Choose **Create**.
3. Name: `Signal by StackEnhance`. URL: `https://mcp.stackenhance.com/mcp`. Authentication: **None**.
4. Start a new chat and turn the connector on from the **+** menu.

### Claude Code

```bash
claude mcp add --transport http signal-by-stackenhance https://mcp.stackenhance.com/mcp
```

### Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "signal-by-stackenhance": {
      "url": "https://mcp.stackenhance.com/mcp"
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "signal-by-stackenhance": {
      "type": "http",
      "url": "https://mcp.stackenhance.com/mcp"
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "signal-by-stackenhance": {
      "serverUrl": "https://mcp.stackenhance.com/mcp"
    }
  }
}
```

### Clients that only run local (stdio) servers

Bridge to the remote server with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "signal-by-stackenhance": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.stackenhance.com/mcp"]
    }
  }
}
```

## Privacy

When an assistant uses the server, StackEnhance receives only the tool request (the brand, market, category, date range or number of results asked about) and technical request data, such as the IP address of the system that connects. When ChatGPT or Claude call the server from their own infrastructure, that is normally the AI provider's address, not yours. The server never receives your conversation or your identity, and nothing it receives is linked to an account. Full details: [privacy policy, section 13](https://stackenhance.com/privacy).

## Limits

Use is free and subject to a fair-use rate limit per IP address. Answers are aggregates of what Signal observed; a brand Signal does not track, or tracks with too little data, is reported as not available rather than guessed.

## Support

- Help: [Ask Signal questions in ChatGPT and Claude](https://stackenhance.com/help/signal-in-chatgpt-and-claude)
- Email: [support@stackenhance.com](mailto:support@stackenhance.com)
- [Privacy policy](https://stackenhance.com/privacy) · [Terms of service](https://stackenhance.com/terms)

## Development

```bash
npm install
npm run dev     # http://localhost:3333/mcp, against the production facts API
npm test
```

`SIGNAL_API_URL` points the server at another facts API; `SIGNAL_MCP_KEY` is an optional key that gives a deployment its own rate-limit tier. The server has no database access: its only data source is the public Signal facts API.

---

Built by [Stack Enhance AB](https://stackenhance.com), Sweden.

<!-- Maintainers: architecture, data boundary and operator steps live in the private monorepo at .claude/SIGNAL_MCP.md. -->
