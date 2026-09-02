/**
 * GET /api/providers
 *
 * Live readiness of every fantasy provider + the persistence subsystem. Uses
 * actual health probes, never hard-coded values.
 */

import { reportProviderStatus } from "@/lib/providers/registry";
import { getLeagueRegistry, leagueConfigStatus } from "@/lib/leagues/registry";
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
    leagues: targets.map((t) => ({
      league_slug: t.key,
      provider: t.provider,
      season: t.season,
      config_status: leagueConfigStatus(t),
      external_league_id: t.external_league_id,
    })),
  };

  return jsonResponse(body, {
    headers: { "Cache-Control": cacheHeader(30, 120) },
  });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
