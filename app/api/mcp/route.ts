/**
 * POST /api/mcp (also served at /mcp) — the Bloodline Bowl remote MCP server.
 *
 * Streamable HTTP, stateless: mcp-handler serves the 2026-07-28 MCP
 * specification natively (no protocol sessions) and falls back to stateless
 * Streamable HTTP for 2025-era clients, so ChatGPT, Claude, Grok and any
 * standard MCP client can connect to the same URL. No session store, no Redis.
 *
 * Read-only. Every tool wraps an existing public bridge route in-process
 * (lib/mcp/invoke.ts); nothing here writes to Sleeper, Yahoo or Supabase
 * beyond what those routes already do when called over HTTP.
 *
 * Access: PUBLIC_READ_ONLY (lib/mcp/contract.ts) — the same data the public
 * `/api/*` routes already serve anonymously. Authentication is designed but not
 * enabled; see docs/MCP_CONNECTOR.md.
 */

import { createMcpHandler } from "mcp-handler";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, SERVER_INSTRUCTIONS } from "@/lib/mcp/contract";
import { registerTools } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Trade discovery can take ~60 s on a cold instance; route timeouts inside tools are lower.
export const maxDuration = 300;

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    instructions: SERVER_INSTRUCTIONS,
    // Stateless deployment: no server-initiated subscription streams.
    maxSubscriptions: 0,
  },
);

// POST only: the deployment is stateless, so there is no GET SSE stream and no DELETE session (proxy answers 405, as the spec allows).
export { handler as POST };
