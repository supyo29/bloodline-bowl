/**
 * GET /api/lineup/{league}/{manager}/week/{week}
 *
 * Optimal legal starting lineup for the league's actual roster rules (slot
 * assignment, not a points sort) + explicit start/sit comparisons for close
 * calls. Shared services only — no logic in this route.
 */

import { runWithWeeklyContext, buildCloseCalls } from "@/lib/weekly/intelligence";
import { buildOptimalLineup } from "@/lib/weekly/lineup";
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

  const view = await runWithWeeklyContext(league, manager, { week: parsed.week }, (ctx) => {
    const players = new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));
    const lineup = buildOptimalLineup({
      week: ctx.league.week,
      roster: ctx.roster,
      constraints: ctx.league.roster_constraints,
      players,
      projections: ctx.projections,
    });
    // Same start/sit derivation as the intelligence endpoint — paired
    // entering/leaving sets, cross-position reshuffle legs excluded.
    const start_sit = buildCloseCalls(ctx, lineup);
    return { lineup, start_sit, roster_constraints: ctx.league.roster_constraints };
  });

  return viewResponse(view, `lineup:${league}/${manager}/w${parsed.week}`);
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
