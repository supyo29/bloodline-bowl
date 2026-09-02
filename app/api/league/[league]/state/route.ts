/**
 * GET /api/league/{league}/state
 *
 * Canonical, provider-independent current state of one league. Resolves the
 * slug through the registry, picks the provider, and returns a
 * `CanonicalLeagueSnapshot` — the same shape the snapshot job persists.
 *
 * Degraded states are explicit: `live_provider_status` and
 * `history_persistence_status` are reported separately, so a Supabase outage
 * still returns live league data (with a `HISTORY_PERSISTENCE_UNAVAILABLE`
 * warning), and a Yahoo league with no credentials returns `AUTH_REQUIRED`
 * rather than fabricated data.
 */

import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ league: string }> },
): Promise<Response> {
  const { league } = await params;
  const result = await buildCanonicalLeagueState(league);

  if (!result.snapshot) {
    return errorResponse(result.status, result.code ?? "league_state_unavailable", result.detail);
  }

  const snap = result.snapshot;
  const healthy =
    snap.live_provider_status === "READY" && snap.history_persistence_status === "READY";

  return jsonResponse(
    {
      status: healthy ? "READY" : "DEGRADED",
      live_provider_status: snap.live_provider_status,
      history_persistence_status: snap.history_persistence_status,
      warnings: snap.warnings,
      state: snap,
    },
    {
      status: result.status,
      headers: {
        "Cache-Control": healthy ? cacheHeader(45, 180) : cacheHeader(15, 60),
        "X-Bridge-Context": `league:${league}`,
      },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
