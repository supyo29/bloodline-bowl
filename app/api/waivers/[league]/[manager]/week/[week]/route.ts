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
import { handleOptions, jsonResponse } from "@/lib/http";

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

  const view = await runWithWeeklyContext(league, manager, { week: parsed.week }, (ctx) =>
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
        context: view.context_meta ?? null,
        data: view.data,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store", "X-Bridge-Context": contextLabel },
      },
    );
  }

  return viewResponse(view, contextLabel);
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
