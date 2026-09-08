/**
 * GET /api/player-scheme
 *
 * Phase 9 (Player x Scheme Interaction Intelligence) — index + manifest for the
 * dedicated read-only namespace. ADDITIVE. No production influence (spec §1,
 * §37, §44). Tier A: PBP-only spatial descriptive profiles, SHARED_DESCRIPTIVE.
 */
import { loadPlayerSchemeIntelligence } from "@/lib/player-scheme-intelligence";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const psi = loadPlayerSchemeIntelligence();
  if (!psi) return errorResponse(503, "player_scheme_unavailable", "No Phase 9 snapshot is published.");
  return jsonResponse(
    {
      status: "READY",
      manifest: psi.manifest,
      player_count: psi.directory.length,
      surfaces: [
        "GET /api/player-scheme/players/{playerId}?view=summary|qb|receiving|rushing",
        "GET /api/player-scheme/teams/{team}/defense",
        "GET /api/player-scheme/matchups/{playerId}/{opponent}?window=career|recent",
      ],
      notes: [
        "Tier A is PBP-only and LIVE_CAPABLE; deployment = SHARED_DESCRIPTIVE.",
        `current_season_status = ${psi.manifest.current_season_status} (spec §3).`,
        "Matchup output is a descriptive tendency-overlap only; numeric_fantasy_adjustment = 0.",
      ],
    },
    { headers: { "Cache-Control": cacheHeader(300, 900) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
