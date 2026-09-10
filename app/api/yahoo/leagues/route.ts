/**
 * GET /api/yahoo/leagues
 *
 * Live, read-only Yahoo league discovery for the authorized account:
 *   - dynamically resolved 2026 NFL game key,
 *   - every NFL league the authenticated account belongs to,
 *   - validation of the configured leagues (Rogers Park 287140,
 *     Maclin on Chick's XVI 82713) against Yahoo's own league names.
 *
 * Fail-closed: when Yahoo returns 403 (or any non-CONNECTED state) this returns
 * a deterministic, sanitized body with `access_state` set accordingly, empty
 * league arrays, `game_key: null`, and `Cache-Control: no-store`. It never
 * fabricates leagues, never guesses a game key, never substitutes Sleeper data.
 */

import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { accessStateFromSession } from "@/lib/providers/yahoo/access-state";
import { runLeagueDiscovery } from "@/lib/providers/yahoo/diagnostics";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(): Promise<Response> {
  const session = await loadYahooSession();

  if (session.state !== "READY" || !session.client) {
    const access = accessStateFromSession(session);
    return jsonResponse(
      {
        provider: "yahoo",
        access_state: access.state,
        access_detail: access.detail,
        detail: session.detail,
        game_key: null,
        discovered_leagues: [],
        configured_leagues: [],
      },
      {
        status: session.state === "NOT_CONFIGURED" || session.state === "STORAGE_UNAVAILABLE" ? 503 : 409,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const report = await runLeagueDiscovery(session.client, {
    overrideKey: session.config?.game_key_override ?? null,
  });

  const connected = report.access_state === "CONNECTED";
  return jsonResponse(
    { provider: "yahoo", ...report },
    {
      // Only a genuine CONNECTED result with resolved data is cacheable; a 403 /
      // rate-limit / network state must not be cached as league state.
      headers: { "Cache-Control": connected ? cacheHeader(60, 300) : "no-store" },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
