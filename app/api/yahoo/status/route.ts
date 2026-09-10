/**
 * GET /api/yahoo/status
 * GET /api/yahoo/status?probe=1   — also make ONE read-only Fantasy API call to
 *                                   classify the Fantasy-grant state.
 *
 * Safe diagnostic surface. Reports configuration, OAuth connection, token
 * health, and (with ?probe=1) whether the Fantasy Sports API itself will answer.
 * A healthy OAuth token that gets HTTP 403 from the Fantasy API is reported as
 * `access_state: "FANTASY_API_FORBIDDEN"` — never as an OAuth failure.
 *
 * Never returns: client secret, refresh/access token, authorization code,
 * Authorization header, Supabase key, encryption key.
 */

import { loadYahooConfig, YAHOO_TARGET_SEASON } from "@/lib/providers/yahoo/config";
import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { accessStateFromSession, refineWithFantasyProbe } from "@/lib/providers/yahoo/access-state";
import { verifyAuthenticatedAccess } from "@/lib/providers/yahoo/discovery";
import { getLeagueRegistry } from "@/lib/leagues/registry";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const cfg = loadYahooConfig();
  const session = await loadYahooSession();
  const wantProbe = new URL(request.url).searchParams.get("probe") === "1";

  let access = accessStateFromSession(session);
  let fantasy_api: {
    probed: boolean;
    reachable: boolean | null;
    detail: string | null;
  } = { probed: false, reachable: null, detail: null };

  if (wantProbe && session.state === "READY" && session.client) {
    const identity = await verifyAuthenticatedAccess(session.client);
    access = refineWithFantasyProbe(access, identity.ok ? null : identity.error);
    fantasy_api = {
      probed: true,
      reachable: identity.ok,
      detail: identity.ok ? "Yahoo Fantasy API answered an authenticated request." : identity.detail,
    };
  }

  const yahooLeagues = getLeagueRegistry().targets.filter((t) => t.provider === "yahoo");

  return jsonResponse(
    {
      provider: "yahoo",
      generated_at: new Date().toISOString(),
      configured: cfg.configured,
      missing_env: cfg.missing,
      encryption_key_present: cfg.encryption_key_present,
      token_storage_backend: session.token.backend,
      // Canonical field:
      access_state: access.state,
      access_detail: access.detail,
      fantasy_api,
      // Retained for back-compat:
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
    // A probe result must never be cached; the plain status is briefly cacheable.
    { headers: { "Cache-Control": wantProbe ? "no-store" : cacheHeader(15, 60) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
