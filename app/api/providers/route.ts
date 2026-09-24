/**
 * GET /api/providers
 *
 * Live readiness of every fantasy provider + the persistence subsystem. Uses
 * actual health probes, never hard-coded values.
 */

import { reportProviderStatus } from "@/lib/providers/registry";
import { getLeagueRegistry, leagueConfigStatus } from "@/lib/leagues/registry";
import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { YahooProvider } from "@/lib/providers/yahoo/provider";
import { getPersistence } from "@/lib/persistence";
import { loadSupabaseConfig } from "@/lib/persistence/supabase/rest";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(): Promise<Response> {
  const [providers, persistenceStatus] = await Promise.all([
    reportProviderStatus(),
    getPersistence().status().catch(() => "PERSISTENCE_ERROR" as const),
  ]);

  const supabaseCfg = loadSupabaseConfig();
  const { targets } = getLeagueRegistry();
  const yahooOAuthConfigured = loadYahooConfig().configured;
  // Static `config_status` distinguishes "no Yahoo app configured at all"
  // from "configured but this specific league's live accessibility isn't
  // known from a static read" (see `leagueConfigStatus` doc comment). This
  // route ALSO performs the live per-league probe those Yahoo entries need to
  // resolve to READY / FORBIDDEN / etc. — accurate per-request accessibility,
  // never a hard-coded league key.
  const leagues = await Promise.all(
    targets.map(async (t) => {
      const config_status = leagueConfigStatus(t, { yahooOAuthConfigured });
      const base = {
        league_slug: t.key,
        provider: t.provider,
        season: t.season,
        config_status,
        external_league_id: t.external_league_id,
        provider_connection_id: t.yahoo_connection_id,
        authorize_url:
          t.provider === "yahoo"
            ? `/api/yahoo/auth/start?league=${encodeURIComponent(t.key)}`
            : null,
        provider_status_url:
          t.provider === "yahoo"
            ? `/api/yahoo/status?league=${encodeURIComponent(t.key)}`
            : null,
      };
      if (t.provider !== "yahoo" || config_status !== "LIVE_VALIDATION_REQUIRED") {
        return { ...base, live_accessible: t.provider === "sleeper" ? true : null, live_detail: null };
      }
      // Yahoo auth is per registered connection. Rogers Park may be healthy
      // while Maclin is unconnected (or vice versa), so never gate one league
      // on the provider-level/default connection health.
      const yahooProvider = new YahooProvider({
        connectionId: t.yahoo_connection_id ?? undefined,
      });
      const yahooConnectionHealth = await yahooProvider.healthCheck();
      if (yahooConnectionHealth.status !== "READY") {
        return {
          ...base,
          live_accessible: null,
          live_detail:
            `Yahoo connection "${t.yahoo_connection_id ?? "primary"}" is ${yahooConnectionHealth.status}: ` +
            yahooConnectionHealth.detail,
        };
      }
      const access = await yahooProvider.checkLeagueAccessibility(t.external_league_id, t.season);
      return {
        ...base,
        live_accessible: access.accessible,
        live_detail: access.accessible
          ? `Yahoo confirms "${access.league_name}" (${access.league_key}) is accessible to the connected account.`
          : access.detail,
      };
    }),
  );

  const body = {
    generated_at: new Date().toISOString(),
    providers: Object.fromEntries(
      providers.map((p) => [
        p.provider,
        {
          status: p.status,
          authentication: p.authentication,
          detail: p.detail,
          capabilities: p.capabilities,
          checked_at: p.checked_at,
        },
      ]),
    ),
    persistence: {
      backend: supabaseCfg.configured ? "supabase" : "none",
      status: persistenceStatus,
      missing_env: supabaseCfg.missing,
    },
    leagues,
  };

  return jsonResponse(body, {
    headers: { "Cache-Control": cacheHeader(30, 120) },
  });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
