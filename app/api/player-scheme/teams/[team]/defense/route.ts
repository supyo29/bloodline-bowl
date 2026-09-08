/**
 * GET /api/player-scheme/teams/{team}/defense
 *
 * Phase 9 Tier A — an opponent defense's spatial vulnerability map (allowed
 * target grid on the same depth x third definitions as the QB/receiver
 * matrices) + rush-direction defense. READ-ONLY, SHARED_DESCRIPTIVE (spec §18).
 */
import { buildDefenseProfile } from "@/lib/player-scheme-intelligence";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ team: string }> },
): Promise<Response> {
  const { team } = await params;
  const body = buildDefenseProfile(team);
  if (!body) return errorResponse(503, "player_scheme_unavailable", "No Phase 9 snapshot is published.");
  if ((body as { availability?: string }).availability === "NOT_AVAILABLE") {
    return jsonResponse(
      { status: "NOT_AVAILABLE", detail: `No defense profile for team '${team}'.`, profile: body },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  return jsonResponse(
    { status: "READY", profile: body },
    { headers: { "Cache-Control": cacheHeader(300, 900) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
