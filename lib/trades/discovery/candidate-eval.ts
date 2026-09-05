/**
 * Trade Engine — Phase 4: candidate validation + canonical evaluation.
 *
 * THIS is the file that enforces the Phase 4 core invariant. Every candidate
 * package discovery generates is turned into a real `NormalizedProposal`,
 * run through the UNCHANGED `validateTrade` (`lib/trades/validate.ts`), and
 * scored by the UNCHANGED `evaluateTrade` (`lib/trades/evaluate.ts`) — the
 * exact functions `POST /api/trades/analyze` uses. There is no
 * discovery-specific scoring function anywhere in this module.
 *
 * Shared context (ownership map, player-position map, manager/team lookups)
 * is built ONCE per discovery request (`DiscoveryEvalContext`) and reused
 * across every candidate — no re-fetch of provider state per candidate
 * (Phase 4 performance requirement §53).
 */

import type { CanonicalFantasyTeam, CanonicalManager } from "@/lib/canonical/schema";
import type { TradeAnalysisContext } from "../context";
import { validateTrade, type TradeResolution } from "../validate";
import { evaluateTrade, type TradeEvaluationOutput } from "../evaluate";
import type { TradeConfig } from "../config";
import type { NormalizedProposal, TradeParticipantInput } from "../schema";

export interface DiscoveryEvalContext {
  ownership: Map<string, string>; // canonical_player_id -> canonical_team_id
  player_positions: Map<string, string[]>;
  manager_by_id: Map<string, CanonicalManager>;
  team_by_manager: Map<string, CanonicalFantasyTeam>;
}

export function buildDiscoveryEvalContext(ctx: TradeAnalysisContext): DiscoveryEvalContext {
  const ownership = new Map<string, string>();
  for (const r of ctx.snapshot.rosters) for (const id of r.all_players) ownership.set(id, r.canonical_team_id);
  const player_positions = new Map<string, string[]>(
    ctx.snapshot.players.map((p) => [p.canonical_player_id, [p.position, ...p.eligible_positions]]),
  );
  const manager_by_id = new Map(ctx.snapshot.managers.map((m) => [m.canonical_manager_id, m]));
  const team_by_manager = new Map<string, CanonicalFantasyTeam>();
  for (const t of ctx.snapshot.teams) for (const mid of t.canonical_manager_ids) team_by_manager.set(mid, t);
  return { ownership, player_positions, manager_by_id, team_by_manager };
}

export interface EvaluatedCandidate {
  ok: boolean;
  rejection_reason: string | null;
  evaluation: TradeEvaluationOutput | null;
}

/**
 * Validates and evaluates one candidate transfer set. `transfers` are ALREADY
 * canonical (this module only ever sees canonical ids — discovery never
 * fabricates a raw/provider-facing id). Returns `ok: false` with a reason if
 * `validateTrade` rejects the candidate (illegal ownership, duplicate asset,
 * roster-size violation, etc.) — the SAME validator every trade in this repo
 * goes through.
 */
export function evaluateCandidate(
  participantManagerIds: string[],
  transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>,
  ctx: TradeAnalysisContext,
  evalCtx: DiscoveryEvalContext,
  config: TradeConfig,
): EvaluatedCandidate {
  const resolution: TradeResolution = {
    league_slug: ctx.league_slug,
    participants: participantManagerIds.map((mid) => {
      const m = evalCtx.manager_by_id.get(mid);
      const t = evalCtx.team_by_manager.get(mid);
      return { input_id: mid, canonical_manager_id: mid, manager_slug: m?.manager_slug ?? mid, canonical_team_id: t?.canonical_team_id ?? null };
    }),
    transfers: transfers.map((t) => ({
      from_input: t.from_manager_id,
      to_input: t.to_manager_id,
      from_manager_id: t.from_manager_id,
      to_manager_id: t.to_manager_id,
      input_player_id: t.canonical_player_id,
      canonical_player_id: t.canonical_player_id,
    })),
    ownership: evalCtx.ownership,
    roster_by_manager: ctx.rosters_by_manager,
    constraints: ctx.constraints,
    player_positions: evalCtx.player_positions,
  };

  const { result, normalized } = validateTrade(resolution);
  if (!result.ok || !normalized) {
    return { ok: false, rejection_reason: result.failures.map((f) => f.message).join("; ") || "validation failed", evaluation: null };
  }

  const participants: TradeParticipantInput[] = normalized.participant_manager_ids.map((mid) => ({
    manager: evalCtx.manager_by_id.get(mid)!,
    team: evalCtx.team_by_manager.get(mid)!,
    roster: ctx.rosters_by_manager.get(mid)!,
  }));

  const evaluation = evaluateTrade({
    normalized,
    week: ctx.week,
    constraints: ctx.constraints,
    team_count: ctx.team_count,
    projections: ctx.projections,
    replacement: ctx.replacement,
    players_by_id: ctx.players_by_id,
    participants,
    config,
    projections_status: "READY",
    context: ctx,
  });

  return { ok: true, rejection_reason: null, evaluation };
}

export function normalizedFromTransfers(
  leagueSlug: string,
  participantManagerIds: string[],
  transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>,
): NormalizedProposal {
  return {
    league_slug: leagueSlug,
    participant_manager_ids: participantManagerIds,
    transfers: transfers.map((t) => ({ from_manager_id: t.from_manager_id, to_manager_id: t.to_manager_id, canonical_player_id: t.canonical_player_id, input_player_id: t.canonical_player_id })),
  };
}
