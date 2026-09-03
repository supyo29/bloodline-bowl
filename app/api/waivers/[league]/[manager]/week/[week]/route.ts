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
import { handleOptions } from "@/lib/http";

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

  return viewResponse(view, `waivers:${league}/${manager}/w${parsed.week}`);
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
