/**
 * GET /api/waivers/{league}/{manager}/week/{week}
 *
 * League-aware acquisition engine (not a "top available" list). Every candidate
 * is paired with the drop it requires; the engine returns DO_NOT_ADD when the
 * wire is not worth the drop. Free agency comes only from canonical, this-league
 * availability — a rostered player can never appear.
 */

import { runWithWeeklyContext } from "@/lib/weekly/intelligence";
import { buildWaiverRecommendations } from "@/lib/weekly/waivers";
import { parseWeek, viewResponse } from "@/lib/weekly/routes-shared";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ league: string; manager: string; week: string }> },
): Promise<Response> {
  const { league, manager, week: weekRaw } = await params;
  const parsed = parseWeek(weekRaw);
  if (!parsed.ok) return parsed.response;
  const limit = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "8", 10);

  // Waiver-readiness-contract fix: certify the free-agent pool against the same
  // canonical Market State substrate Waiver 2.0 already consumes, instead of the
  // always-null canonical `waiver_state`. See lib/weekly/market-pool-adapter.ts.
  const view = await runWithWeeklyContext(league, manager, { week: parsed.week, enableMarketStatePool: true }, (ctx) =>
    buildWaiverRecommendations(ctx, { limit: Number.isFinite(limit) ? Math.min(25, Math.max(1, limit)) : 8 }),
  );

  const contextLabel = `waivers:${league}/${manager}/w${parsed.week}`;

  // Readiness contract: the canonical free-agent pool is not materialized/certified.
  // Serve HTTP 200 (the read-endpoint convention) but report the NOT_READY state
  // explicitly — no add/drop pairs, nothing labelled CURRENT/FRESH. An HTTP 200
  // does NOT make the underlying data actionable.
  if (view.data && view.data.availability_status === "UNAVAILABLE") {
    return jsonResponse(
      {
        status: "NOT_READY",
        reason_code: view.data.unavailable_reason_code,
        detail:
          "Current free-agent pool is not materialized/certified for this league; waiver / free-agent / pickup / add-drop recommendations are unavailable. Unrostered in ownership data is not the same as a certified free agent.",
        capability: view.data.unavailable_detail,
        readiness: view.data.readiness,
        market_status: view.data.readiness.market.status,
        projection_status: view.data.readiness.weekly_projections.status,
        recommendation_status: view.data.readiness.waiver_recommendations.status,
        context: view.context_meta ?? null,
        data: view.data,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store", "X-Bridge-Context": contextLabel },
      },
    );
  }

  if (!view.data) return viewResponse(view, contextLabel);
  const meta = view.context_meta!;
  const healthy = view.data.readiness.waiver_recommendations.status === "READY";
  return jsonResponse(
    {
      // Backward-compatible aggregate context status. Do NOT use this field to
      // infer market actionability; use the explicit Phase 4 fields below.
      status: meta.status,
      market_status: view.data.readiness.market.status,
      projection_status: view.data.readiness.weekly_projections.status,
      ros_status: view.data.readiness.rest_of_season.status,
      recommendation_status: view.data.readiness.waiver_recommendations.status,
      readiness: view.data.readiness,
      context: meta,
      data: view.data,
    },
    {
      headers: {
        "Cache-Control": healthy ? cacheHeader(120, 300) : cacheHeader(45, 120),
        "X-Bridge-Context": contextLabel,
      },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
