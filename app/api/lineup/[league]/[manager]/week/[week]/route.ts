/**
 * GET /api/lineup/{league}/{manager}/week/{week}
 *
 * Optimal legal starting lineup for the league's actual roster rules (slot
 * assignment, not a points sort) + explicit start/sit comparisons for close
 * calls. Shared services only — no logic in this route.
 */

import { runWithWeeklyContext, lineupEndpointView } from "@/lib/weekly/intelligence";
import { parseWeek, viewResponse } from "@/lib/weekly/routes-shared";
import { handleOptions } from "@/lib/http";

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

  // W1.R1: the SAME view function /api/intelligence uses (canonical injury-aware decision value + matching close calls).
  const view = await runWithWeeklyContext(league, manager, { week: parsed.week }, lineupEndpointView);

  return viewResponse(view, `lineup:${league}/${manager}/w${parsed.week}`);
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
