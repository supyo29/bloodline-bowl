/**
 * GET /api/matchup/{league}/{manager}/week/{week}
 *
 * Both teams evaluated on their best LEGAL projected lineup: projected totals,
 * margin, positional edges, high-leverage & swing players, bench depth,
 * replacement vulnerability, and (when coverage supports it) a seeded
 * Monte-Carlo win probability with explicit method + LOW confidence.
 */

import { runWithWeeklyContext } from "@/lib/weekly/intelligence";
import { buildMatchup, buildLeverage } from "@/lib/weekly/matchup";
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
    const matchup = buildMatchup(ctx);
    return { matchup, leverage: buildLeverage(matchup) };
  });

  return viewResponse(view, `matchup:${league}/${manager}/w${parsed.week}`);
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
