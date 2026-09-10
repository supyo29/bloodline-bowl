/**
 * GET /api/yahoo/status
 *
 * Safe diagnostic surface for the Yahoo integration. Reports configuration,
 * authorization, and token health WITHOUT ever returning a secret. No live
 * Yahoo API call beyond a token refresh (which touches only Yahoo's OAuth
 * endpoint, never league data) — the heavier authenticated probe lives at
 * /api/yahoo/diagnostics behind REFRESH_SECRET.
 *
 * Never returns: client secret, refresh token, access token, authorization code.
 */

import { loadYahooConfig, YAHOO_TARGET_SEASON } from "@/lib/providers/yahoo/config";
import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { getLeagueRegistry } from "@/lib/leagues/registry";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const cfg = loadYahooConfig();
  const session = await loadYahooSession();

  const yahooLeagues = getLeagueRegistry().targets.filter((t) => t.provider === "yahoo");

  return jsonResponse(
    {
      provider: "yahoo",
      generated_at: new Date().toISOString(),
      configured: cfg.configured,
      missing_env: cfg.missing,
      encryption_key_present: cfg.encryption_key_present,
      token_storage_backend: session.token.backend,
      session_state: session.state,
      detail: session.detail,
      authorized: session.token.connected,
      token_healthy: session.token.healthy,
      token_expires_at: session.token.expires_at,
      token_expires_in_seconds: session.token.expires_in_seconds,
      yahoo_guid: session.token.yahoo_guid,
      target_season: YAHOO_TARGET_SEASON,
      configured_leagues: yahooLeagues.map((t) => ({
        league_slug: t.key,
        yahoo_league_id: t.external_league_id,
        yahoo_league_key: t.yahoo_league_key,
        display_name: t.display_name,
      })),
      authorize_url: cfg.configured ? "/api/yahoo/auth/start" : null,
      diagnostics_url: "/api/yahoo/diagnostics (POST, Authorization: Bearer <REFRESH_SECRET>)",
    },
    { headers: { "Cache-Control": cacheHeader(15, 60) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
