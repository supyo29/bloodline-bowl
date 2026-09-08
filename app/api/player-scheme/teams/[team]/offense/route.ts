/**
 * GET /api/player-scheme/teams/{team}/offense
 *
 * Phase 9 Tier C — a team's DESCRIPTIVE offensive tendency profile (formation
 * mix, target-area distribution, rush direction, play-action/motion/RPO/screen
 * rate, box faced). Per-column availability (pbp = LIVE_CAPABLE; participation /
 * FTN = PRIOR_ONLY / DESCRIPTIVE_ONLY). READ-ONLY, SHARED_DESCRIPTIVE.
 *
 * The opponent-adjusted MODELED ratings remain owned by Football Intelligence.
 */
import { buildTeamOffenseProfile } from "@/lib/player-scheme-intelligence";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ team: string }> },
): Promise<Response> {
  const { team } = await params;
  const body = buildTeamOffenseProfile(team);
  if (!body) return errorResponse(503, "player_scheme_unavailable", "No Phase 9 snapshot is published.");
  if ((body as { availability?: string }).availability === "NOT_AVAILABLE") {
    return jsonResponse(
      { status: "NOT_AVAILABLE", detail: `No offense profile for team '${team}'.`, profile: body },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  return jsonResponse({ status: "READY", profile: body }, { headers: { "Cache-Control": cacheHeader(300, 900) } });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
