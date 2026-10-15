/**
 * GET /api/yahoo/health — credential-free Yahoo connection health for every registered connection (maclin, primary).
 * Timestamps/enums/booleans only: no tokens, no keys, no Authorization headers. Read-only: it never refreshes or writes.
 */
import { listYahooConnectionBindings } from "@/lib/providers/yahoo/connections";
import { getYahooConnectionHealth } from "@/lib/providers/yahoo/health";
import { resolveYahooTokenStore } from "@/lib/providers/yahoo/token-store";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  const out = [];
  for (const b of listYahooConnectionBindings()) {
    const r = resolveYahooTokenStore(process.env, { connectionId: b.connection_id });
    if (!r.ok) { out.push({ connection_id: b.connection_id, league_slugs: b.league_slugs, status: "STORE_UNAVAILABLE", detail: "No durable encrypted token store is configured." }); continue; }
    out.push({ ...(await getYahooConnectionHealth(b.connection_id, r.store)), league_slugs: b.league_slugs });
  }
  const bad = out.filter((c) => c.status !== "HEALTHY");
  return jsonResponse({ provider: "yahoo", checked_at: new Date().toISOString(), all_healthy: bad.length === 0, connections: out }, { headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
