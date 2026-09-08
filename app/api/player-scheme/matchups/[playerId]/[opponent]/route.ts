/**
 * GET /api/player-scheme/matchups/{playerId}/{opponent}?window=career|recent
 *
 * Phase 9 Tier A — DESCRIPTIVE tendency-overlap between a player's spatial
 * profile and an opponent defense's spatial vulnerability (spec §33, §34).
 *
 * This is NOT the Tier D validated player x scheme interaction model. The
 * response carries `numeric_fantasy_adjustment = 0`, `deployment =
 * "SHADOW_ONLY"`, `validation_status = "SHARED_DESCRIPTIVE"`. No production
 * influence (spec §1, §24, §35, §44).
 */
import { buildMatchupAlignment } from "@/lib/player-scheme-intelligence";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playerId: string; opponent: string }> },
): Promise<Response> {
  const { playerId, opponent } = await params;
  const w = new URL(request.url).searchParams.get("window");
  const window = w === "career" ? "career" : "recent";

  const body = buildMatchupAlignment(playerId, opponent, window);
  if (!body) return errorResponse(503, "player_scheme_unavailable", "No Phase 9 snapshot is published.");
  if ("resolution" in body) {
    return jsonResponse(
      { status: "UNRESOLVED", resolution: "UNRESOLVED", query: playerId, matchup: null },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  if ((body as { availability?: string }).availability === "NOT_AVAILABLE") {
    return jsonResponse(
      { status: "NOT_AVAILABLE", matchup: body },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  return jsonResponse(
    { status: "READY", matchup: body },
    { headers: { "Cache-Control": cacheHeader(300, 900) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
