/**
 * GET /api/league/{league}/market?week=N&view=summary|pool&position=QB|RB|WR|TE|K|DEF&status=FA|W|UNKNOWN
 *
 * READ-ONLY, provider-independent Market State of one league: who is actually acquirable RIGHT NOW, with the evidence behind each answer.
 * Works for Sleeper (availability inferred from rosters + the transaction feed) and Yahoo (availability stated per player by Yahoo's FA / W / T pools).
 *
 *   view=summary (default)  readiness (with the separate availability / valuation / transaction / recommendation AXES), counts, acquisition rules, FAAB /
 *                           priority per team, pending-claim visibility, game-lock semantics, pool pagination evidence, sources, freshness, limitations.
 *   view=pool               everything above PLUS the verified players: free agents, claim-only waiver players, unknown-availability players
 *                           (each with provider status, canonical identity, acquisition method, waiver clear DATE when stated, game state, caveats).
 *
 * It never writes, never submits a claim, and never infers availability from "not on a roster".
 */
import { findLeagueTarget } from "@/lib/leagues/registry";
import { loadMarketSnapshot } from "@/lib/market-state/load";
import { acquirablePlayers, buildFreeAgentPool } from "@/lib/market-state/pool";
import type { PlayerMarketState } from "@/lib/market-state/contract";
import { getNflState } from "@/lib/sleeper/client";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const slim = (p: PlayerMarketState) => ({
  player_key: p.player_key, provider_player_id: p.provider_player_id, canonical_player_id: p.canonical_player_id, name: p.full_name, position: p.position, nfl_team: p.team, entity: p.entity,
  status: p.status, acquisition: p.acquisition, eligible_to_add: p.eligible_to_add, claimable: p.claimable ?? false, waiver_clears_on: p.waiver_clears_on ?? null,
  availability_evidence: p.availability_evidence ?? null, reason: p.reason, lock: p.lock, injury_status: p.injury_status, caveats: p.caveats,
});

export async function GET(request: Request, { params }: { params: Promise<{ league: string }> }): Promise<Response> {
  const { league } = await params;
  const target = findLeagueTarget(league);
  if (!target) return errorResponse(404, "league_not_registered", `No registered league matches "${league}".`);
  const sp = new URL(request.url).searchParams;
  const view = (sp.get("view") ?? "summary").toLowerCase();
  if (view !== "summary" && view !== "pool") return errorResponse(400, "invalid_view", "view must be summary or pool.");
  const position = sp.get("position")?.toUpperCase() ?? null;
  if (position && !POSITIONS.has(position)) return errorResponse(400, "invalid_position", "position must be one of QB, RB, WR, TE, K, DEF.");
  const statusFilter = sp.get("status")?.toUpperCase() ?? null;
  if (statusFilter && !["FA", "W", "UNKNOWN"].includes(statusFilter)) return errorResponse(400, "invalid_status", "status must be FA, W or UNKNOWN.");
  let week = Number.parseInt(sp.get("week") ?? "", 10);
  if (!Number.isFinite(week) || week < 1 || week > 22) week = Math.max(1, Number((await getNflState().catch(() => null))?.week ?? 1));

  const snap = await loadMarketSnapshot(target.key, { week });
  const pool = buildFreeAgentPool(snap);
  const keep = (p: PlayerMarketState) => !position || p.position === position;
  const body = {
    league: { slug: target.key, provider: snap.provider, season: snap.season, week: snap.week },
    market_content_id: snap.identities.market_content_id, as_of: snap.as_of, freshness: snap.freshness ?? null, history_class: snap.history_class,
    readiness: { status: snap.readiness.status, pool_actionable: snap.readiness.pool_actionable, axes: snap.readiness.axes ?? null, blocks: snap.readiness.blocks, limitations: snap.readiness.limitations, reasons: snap.readiness.reasons },
    counts: { ...snap.counts, claimable_waivers: pool.claimable.length, ineligible: snap.ineligible_counts },
    acquisition: { status: snap.acquisition.status, rules: snap.acquisition.rules, teams: snap.acquisition.teams },
    pending_claim_visibility: snap.pending_claim_visibility ?? { status: "NOT_EXPOSED", reason: "provider does not expose pending claims" },
    game_lock_semantics: snap.game_lock_semantics ?? null, pool_evidence: snap.pool_evidence ?? null, sources: snap.sources, scoring_fingerprint: snap.identities.scoring_fingerprint, limitations: snap.limitations,
    advisory: "Read-only market state. Bloodline never adds, drops, claims, trades or edits a lineup.",
    ...(view === "pool" ? {
      pool: {
        free_agents: !statusFilter || statusFilter === "FA" ? pool.members.filter(keep).map(slim) : [],
        claimable_waivers: !statusFilter || statusFilter === "W" ? pool.claimable.filter(keep).map(slim) : [],
        unknown: !statusFilter || statusFilter === "UNKNOWN" ? pool.unknown.filter(keep).map(slim) : [],
        acquirable_total: acquirablePlayers(pool).filter(keep).length,
      },
    } : {}),
    generated_at: new Date().toISOString(),
  };
  return jsonResponse(body, { headers: { "Cache-Control": cacheHeader(15, 60), "X-Bridge-Context": `market:${target.key}/w${snap.week}` } });
}

export async function OPTIONS(): Promise<Response> { return handleOptions(); }
