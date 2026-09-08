/**
 * GET /api/leagues/:leagueSlug/orchestrate
 *
 * Phase 8 — Team Management Orchestrator (Scope 2, ADVISORY_ONLY), LEAGUE view.
 *
 * One shared `ManagementAnalysisContext` (one canonical read) → a compact
 * per-manager verdict row for every manager. The cheap path only — trade
 * discovery is NEVER run league-wide (§34). Coordinates and prioritises the
 * frozen Phase 1–7 specialists; executes nothing; mutates no specialist.
 */

import { buildLeagueOrchestration } from "@/lib/orchestrator";
import { leagueContext } from "@/lib/leagues/resolve";
import { resolveLeagueRoute } from "@/lib/leagues/api";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueSlug: string }> },
): Promise<Response> {
  const resolved = await resolveLeagueRoute(params);
  if (!resolved.ok) return resolved.response;
  const { league } = resolved;

  try {
    const res = await buildLeagueOrchestration(league.league_slug);
    if (!res.ok) return errorResponse(res.status, res.code, res.detail);
    return jsonResponse(
      { context: leagueContext(league), deployment: "ADVISORY_ONLY", ...res.result },
      {
        headers: {
          "Cache-Control": cacheHeader(30, 120),
          "X-Bridge-Context": `league:${league.league_slug}`,
          "X-Orchestrator-Version": res.result.orchestrator_version,
          "X-Orchestrator-Deployment": "ADVISORY_ONLY",
        },
      },
    );
  } catch (err) {
    return errorResponse(502, "orchestrator_unavailable", err instanceof Error ? err.message : String(err));
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
