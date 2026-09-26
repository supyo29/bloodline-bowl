/**
 * GET /api/intelligence/{league}/{manager}/week/{week}
 *
 * The combined weekly decision layer: lineup + start/sit + matchup + leverage +
 * waivers, plus `top_actions` (the few moves that matter) and a manager-facing
 * `summary`. All analytics consume the canonical league model; a missing
 * projection / provider / opponent degrades explicitly and never becomes 0.
 */

import { buildWeeklyIntelligence } from "@/lib/weekly/intelligence";
import { parseWeek } from "@/lib/weekly/routes-shared";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ league: string; manager: string; week: string }> },
): Promise<Response> {
  const { league, manager, week: weekRaw } = await params;
  const parsed = parseWeek(weekRaw);
  if (!parsed.ok) return parsed.response;

  // Waiver-readiness-contract fix: the same Market State certification the
  // direct waivers route uses, so the two surfaces cannot disagree on
  // whether the free-agent pool is actionable. See
  // lib/weekly/market-pool-adapter.ts.
  const result = await buildWeeklyIntelligence(league, manager, { week: parsed.week, enableMarketStatePool: true });

  if (!result.intelligence) {
    if (result.degraded_context) {
      return jsonResponse(
        { status: result.degraded_context.code, detail: result.degraded_context.detail, intelligence: null },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    return errorResponse(result.status, result.code ?? "weekly_intelligence_unavailable", result.detail);
  }

  const healthy = result.intelligence.status === "READY";
  return jsonResponse(
    {
      // Aggregate weekly status remains for compatibility; individual readiness
      // axes below are authoritative for acquisition decisions.
      status: result.intelligence.status,
      market_status: result.intelligence.readiness.market.status,
      projection_status: result.intelligence.readiness.weekly_projections.status,
      ros_status: result.intelligence.readiness.rest_of_season.status,
      waiver_recommendation_status: result.intelligence.readiness.waiver_recommendations.status,
      readiness: result.intelligence.readiness,
      intelligence: result.intelligence,
    },
    {
      headers: {
        "Cache-Control": healthy ? cacheHeader(120, 300) : cacheHeader(45, 120),
        "X-Bridge-Context": `weekly:${league}/${manager}/w${parsed.week}`,
      },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
