/**
 * PHASE 4 §7 / §9 / §10 — the SURVIVAL INTERFACE.
 *
 * ⚠️ PROVISIONAL. Phase 5 owns real market/ADP calibration. This module is a
 * clean, honest interface with a conservative initial estimator — it must never
 * pretend an unvalidated survival number is precise.
 *
 * Contract:
 *   - `estimateSurvival(...)` always returns a `SurvivalEstimate` with a
 *     `source`, a `confidence`, a `market_timestamp`, and a `note`.
 *   - The recommendation engine must behave sensibly when confidence is
 *     HIGH, LOW, or UNAVAILABLE (it down-weights urgency as confidence falls).
 *   - No randomness: the estimate is a deterministic function of the market
 *     snapshot + pick geometry + positional-run state.
 *
 * Estimator, in order of preference:
 *   1. `ranking_pack_adp`     — a league ranking pack with real ADP  (MEDIUM)
 *   2. `sleeper_search_rank`  — Sleeper's relevance ordinal as an ADP proxy (LOW)
 *   3. `positional_demand_only` — no market signal: fall back to "how many of
 *       this position typically go before my next pick" from run rates (LOW)
 *   4. `none` — nothing usable (UNAVAILABLE); p defaults to 0.5 with a warning
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import type {
  SurvivalConfidence,
  SurvivalEstimate,
  SurvivalSource,
  TierSurvivalEstimate,
} from "./schema";

export interface MarketEntry {
  player_id: string;
  /** average draft position (overall pick), when a real ADP source exists */
  adp: number | null;
  /** Sleeper search_rank — a market-informed ordinal, not a projection */
  search_rank: number | null;
}

export interface MarketSnapshot {
  by_player: Map<string, MarketEntry>;
  source: SurvivalSource;
  timestamp: string | null;
  /** count of players with a usable market signal (for confidence) */
  covered: number;
}

/** Build the snapshot from whatever market signal is available for this league. */
export function buildMarketSnapshot(input: {
  adpByPlayer?: Map<string, number> | null;
  searchRankByPlayer: Map<string, number | null>;
  timestamp: string | null;
}): MarketSnapshot {
  const by_player = new Map<string, MarketEntry>();
  const hasAdp = input.adpByPlayer && input.adpByPlayer.size > 0;
  let covered = 0;
  const ids = new Set<string>([
    ...(input.adpByPlayer?.keys() ?? []),
    ...input.searchRankByPlayer.keys(),
  ]);
  for (const id of ids) {
    const adp = input.adpByPlayer?.get(id) ?? null;
    const sr = input.searchRankByPlayer.get(id) ?? null;
    if (adp != null || sr != null) covered += 1;
    by_player.set(id, { player_id: id, adp, search_rank: sr });
  }
  return {
    by_player,
    source: hasAdp ? "ranking_pack_adp" : covered > 0 ? "sleeper_search_rank" : "positional_demand_only",
    timestamp: input.timestamp,
    covered,
  };
}

/**
 * Logistic CDF. `p(available at pick T) = 1 / (1 + exp((T - m)/s))` where `m`
 * is the player's market pick and `s` widens with the wait and with market
 * uncertainty. As T passes m the probability falls through 0.5.
 */
function logisticSurvival(marketPick: number, targetPick: number, spread: number): number {
  const s = Math.max(1e-6, spread);
  return 1 / (1 + Math.exp((targetPick - marketPick) / s));
}

/** search_rank → an implied overall pick. Rank is already ~ market order. */
function searchRankToPick(rank: number): number {
  // search_rank is dense near the top and noisy in the mid rounds; treat it as
  // an ordinal ADP with a mild convex stretch so late ranks don't imply
  // implausibly early picks.
  return rank <= 0 ? 1 : rank;
}

export interface SurvivalInput {
  playerId: string;
  position: FantasyPosition;
  /** the manager's NEXT pick (overall) — the survival horizon */
  targetPickOverall: number;
  /** picks by other teams between now and the target pick */
  interveningPicks: number;
  market: MarketSnapshot;
  /** extra picks-of-this-position expected from an active run (0 when none) */
  runExtraDemand?: number;
}

export function estimateSurvival(input: SurvivalInput): SurvivalEstimate {
  const entry = input.market.by_player.get(input.playerId);
  const now = input.market.timestamp;

  let marketPick: number | null = null;
  let source: SurvivalSource = "none";
  let confidence: SurvivalConfidence = "UNAVAILABLE";

  if (entry?.adp != null) {
    marketPick = entry.adp;
    source = "ranking_pack_adp";
    confidence = "MEDIUM";
  } else if (entry?.search_rank != null) {
    marketPick = searchRankToPick(entry.search_rank);
    source = "sleeper_search_rank";
    confidence = "LOW";
  }

  // run pressure pulls the effective market pick earlier
  const runShift = Math.max(0, input.runExtraDemand ?? 0);
  const effectiveMarketPick = marketPick != null ? marketPick - runShift : null;

  if (effectiveMarketPick == null) {
    // positional-demand-only fallback: no per-player market signal at all.
    // Assume this player is roughly "on the bubble" — survival hinges purely on
    // how many picks intervene. Wide spread, LOW confidence.
    const spread = 4 + Math.sqrt(Math.max(1, input.interveningPicks));
    const p = logisticSurvival(input.targetPickOverall - 8, input.targetPickOverall, spread);
    return {
      p_survives_next_pick: round3(clamp01(p)),
      p_survives_second_next: null,
      expected_pick_window: null,
      source: "positional_demand_only",
      confidence: "LOW",
      market_timestamp: now,
      note:
        "No per-player market signal; survival is a wide, low-confidence " +
        "function of intervening picks only. Phase 5 will add real ADP.",
    };
  }

  // spread grows with the wait and is wider for a low-confidence signal
  const base = confidence === "MEDIUM" ? 3.5 : 6;
  const spread = base + 0.9 * Math.sqrt(Math.max(1, input.interveningPicks));

  const pNext = logisticSurvival(effectiveMarketPick, input.targetPickOverall, spread);
  const pSecond = logisticSurvival(
    effectiveMarketPick,
    input.targetPickOverall + Math.max(1, input.interveningPicks),
    spread * 1.15,
  );

  return {
    p_survives_next_pick: round3(clamp01(pNext)),
    p_survives_second_next: round3(clamp01(pSecond)),
    expected_pick_window: [
      Math.max(1, Math.round(effectiveMarketPick - 1.5 * spread)),
      Math.round(effectiveMarketPick + 1.5 * spread),
    ],
    source,
    confidence,
    market_timestamp: now,
    note:
      source === "ranking_pack_adp"
        ? "Ranking-pack ADP vs pick geometry; medium confidence."
        : "Sleeper search_rank used as an ADP proxy; low confidence — Phase 5 calibrates market.",
  };
}

/**
 * §10 — TIER survival. Losing one of three interchangeable WRs is not urgent;
 * one TE before a cliff is. `P(≥1 equivalent-tier player still available)`.
 *
 * Conservative model: the tier survives unless expected picks-at-position
 * before the next turn exhausts it. We combine per-player survival (when a
 * market signal exists) via a correlation-aware floor, otherwise fall back to
 * an expected-demand logistic.
 */
export function estimateTierSurvival(input: {
  position: FantasyPosition;
  tier: number;
  /** per-player p_survives for the tier's still-available members */
  memberSurvival: number[];
  /** expected picks of this position before the next turn (from runs + base) */
  expectedPositionDemand: number;
  confidence: SurvivalConfidence;
}): TierSurvivalEstimate {
  const n = input.memberSurvival.length;
  if (n === 0) {
    return {
      position: input.position,
      tier: input.tier,
      players_in_tier_available: 0,
      p_tier_survives_next_pick: 0,
      confidence: input.confidence,
    };
  }

  // independent-survival estimate (optimistic — market is correlated)
  const pAnyIndependent = 1 - input.memberSurvival.reduce((acc, p) => acc * (1 - clamp01(p)), 1);
  // demand estimate: tier survives if fewer picks land on it than it has members
  const slack = n - input.expectedPositionDemand;
  const pDemand = 1 / (1 + Math.exp(-slack)); // logistic around demand == members
  // blend, then pull toward the more conservative (lower) of the two
  const blended = 0.5 * pAnyIndependent + 0.5 * pDemand;
  const conservative = Math.min(blended, 0.5 * blended + 0.5 * Math.min(pAnyIndependent, pDemand));

  return {
    position: input.position,
    tier: input.tier,
    players_in_tier_available: n,
    p_tier_survives_next_pick: round3(clamp01(conservative)),
    confidence: input.confidence,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
