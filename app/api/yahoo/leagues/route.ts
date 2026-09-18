/**
 * GET /api/yahoo/leagues
 *
 * Live, read-only Yahoo league discovery for the authorized account:
 *   - dynamically resolved 2026 NFL game key,
 *   - every NFL league the authenticated account belongs to,
 *   - validation of the two configured leagues (Rogers Park 287140,
 *     Maclin on Chick's XVI 82713) against Yahoo's own league names.
 *
 * Returns an explicit degraded body (not fabricated data) when Yahoo is not
 * configured / connected. Never returns tokens.
 */

import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { runLeagueDiscovery } from "@/lib/providers/yahoo/diagnostics";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(): Promise<Response> {
  const session = await loadYahooSession();
  if (session.state !== "READY" || !session.client) {
    return jsonResponse(
      {
        provider: "yahoo",
        status: session.state,
        detail: session.detail,
        discovered_leagues: [],
        configured_leagues: [],
      },
      { status: session.state === "NOT_CONFIGURED" ? 503 : 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const report = await runLeagueDiscovery(session.client, {
    overrideKey: session.config?.game_key_override ?? null,
  });

  return jsonResponse(
    { provider: "yahoo", status: "READY", ...report },
    { headers: { "Cache-Control": cacheHeader(60, 300) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
