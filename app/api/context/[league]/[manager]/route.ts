/**
 * GET /api/context/{league}/{manager}
 *
 * One manager's provider-independent analytical context inside one league.
 * Generic: `supyo29`, `BijiMac`, `DarthMarker`, and any other league member all
 * resolve through the same code path (see `lib/canonical/manager-context.ts`).
 * A non-member manager is an explicit `manager_not_in_league`, never a fallback.
 */

import { buildManagerContext } from "@/lib/canonical/manager-context";
import { resolveFreshnessEnvelope } from "@/lib/canonical/freshness-envelope";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ league: string; manager: string }> },
): Promise<Response> {
  const { league, manager } = await params;
  const result = await buildManagerContext(league, manager);

  if (!result.ok || !result.context) {
    return errorResponse(result.status, result.code ?? "manager_context_unavailable", result.detail);
  }

  // ADDITIVE (Stage D, observational). `manager_context` is unchanged and still
  // legacy-live-path derived; `freshness.state_source` says so.
  const freshness = result.snapshot
    ? await resolveFreshnessEnvelope({
        leagueSlug: result.context.league.league_slug,
        season: result.context.league.season,
        servedSnapshot: result.snapshot,
        stateSource: result.state_source ?? "LEGACY_LIVE_PATH",
        fallback: {
          occurred: result.fallback_reason != null,
          reason: result.fallback_reason ?? null,
        },
      }).catch(() => null)
    : null;

  return jsonResponse(
    {
      context: {
        scope: "manager",
        league_slug: result.context.league.league_slug,
        provider: result.context.league.provider,
        manager_slug: result.context.manager.manager_slug,
        canonical_manager_id: result.context.manager.canonical_manager_id,
        canonical_team_id: result.context.team.canonical_team_id,
        canonical_url: `/api/context/${result.context.league.league_slug}/${result.context.manager.manager_slug}`,
      },
      manager_context: result.context,
      ...(freshness ? { freshness } : {}),
    },
    {
      headers: {
        "Cache-Control": cacheHeader(30, 120),
        "X-Bridge-Context": `manager:${league}/${manager}`,
      },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
