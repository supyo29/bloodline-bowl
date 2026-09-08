/**
 * GET /api/player-scheme/players/{playerId}?view=summary|qb|receiving|rushing
 *
 * Phase 9 Tier A — a player's spatial tendency/efficiency profile. `playerId`
 * is a canonical gsis id, a provider id (sleeper/pfr/espn/yahoo), or an exact
 * full name; unresolved ids return { resolution: "UNRESOLVED" }, never a guess.
 *
 * READ-ONLY, SHARED_DESCRIPTIVE. No production influence (spec §1, §37, §44).
 */
import {
  buildQbProfile,
  buildReceivingProfile,
  buildRushingProfile,
  resolveRef,
} from "@/lib/player-scheme-intelligence";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playerId: string }> },
): Promise<Response> {
  const { playerId } = await params;
  const view = new URL(request.url).searchParams.get("view") ?? "summary";

  const ref = resolveRef(playerId);
  if ("resolution" in ref) {
    return jsonResponse(
      { status: "UNRESOLVED", resolution: "UNRESOLVED", query: playerId, profile: null },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  if (view === "qb") body = buildQbProfile(playerId);
  else if (view === "receiving") body = buildReceivingProfile(playerId);
  else if (view === "rushing") body = buildRushingProfile(playerId);
  else {
    // summary: whichever profiles exist for this player
    const qb = buildQbProfile(playerId);
    const receiving = buildReceivingProfile(playerId);
    const rushing = buildRushingProfile(playerId);
    const has = (p: unknown) => p != null && !(p as { availability?: string }).availability;
    body = {
      player: ref,
      available_profiles: [
        has(qb) ? "qb" : null,
        has(receiving) ? "receiving" : null,
        has(rushing) ? "rushing" : null,
      ].filter(Boolean),
      qb: has(qb) ? qb : null,
      receiving: has(receiving) ? receiving : null,
      rushing: has(rushing) ? rushing : null,
    };
  }

  if (!body) return errorResponse(503, "player_scheme_unavailable", "No Phase 9 snapshot is published.");
  return jsonResponse(
    { status: "READY", profile: body },
    { headers: { "Cache-Control": cacheHeader(300, 900), "X-Bridge-Context": `player-scheme:${ref.gsis_id}:${view}` } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
