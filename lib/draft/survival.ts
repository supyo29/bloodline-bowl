/**
 * PHASE 5 — the SURVIVAL INTERFACE (`survival_version: ri-snake-survival-2026.1`).
 *
 * Replaces the Phase 4 LOW-confidence `search_rank` heuristic with a calibrated
 * market-distribution model, while keeping the exact interface the frozen
 * Phase 4 engine consumes (`MarketSnapshot`, `estimateSurvival`,
 * `estimateTierSurvival`).
 *
 * Model (S2, selected in `analysis/phase5_market_survival.R` against the
 * completed 12-team Devoted 2026 snake draft):
 *
 *   a player's actual draft pick  D_i ~ Normal(mu_i, sigma_i)
 *   mu_i    = market consensus expected overall pick (robust weighted median)
 *   sigma_i = SIGMA_BASE + SIGMA_SLOPE·mu_i + SIGMA_DISP·market_dispersion
 *             (later picks and higher source disagreement ⇒ wider)
 *
 *   P(survive to k)              = P(D_i > k)      = Φ((mu_i − k) / sigma_i)
 *   P(survive to k | avail at c) = P(D_i > k | D_i > c)
 *                                = [1 − Φ((k−mu)/s)] / [1 − Φ((c−mu)/s)]   (§16, §17)
 *
 * A "falling player" (still available well past his ADP) is therefore correctly
 * re-based: conditioning on `D_i > c` lifts every forward probability.
 *
 * Degraded fallback (§29): no market row for a player ⇒ the old search-rank
 * logistic at LOW confidence; no signal at all ⇒ demand-only, LOW confidence.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import type {
  SurvivalConfidence,
  SurvivalEstimate,
  SurvivalSource,
  TierSurvivalEstimate,
} from "./schema";
import {
  buildMarketConsensus,
  searchRankToPick,
  type MarketConfidence,
  type MarketConsensusTable,
} from "./market";

export const SURVIVAL_MODEL_VERSION = "ri-snake-survival-2026.1";

/**
 * Calibrated sigma model — `analysis/phase5_market_survival.R`, fit on the
 * completed Devoted-2026 12-team snake draft (signed residual sd of
 * `actual_pick − market_expected_pick`, binned by pick, decision-relevant range
 * ≤ 96). Source disagreement widens it (coefficient constrained ≥ 0).
 *
 *   sigma = clamp(3.00 + 0.186·expected_pick + 0.90·dispersion, 3.0, 22)
 *
 * Held-out (leave-one-draft-slot-out) Brier: 0.115 vs 0.184 for the search-rank
 * proxy — a 37% reduction. Well calibrated across all horizons 1..23 and all
 * probability bins (`phase5_calibration_bins.csv`).
 */
export const SIGMA_BASE = 3.0;
export const SIGMA_SLOPE = 0.186;
export const SIGMA_DISP = 0.9;
const SIGMA_FLOOR = 3.0;
/** past ~pick 96 ADP carries little signal; clamp so the model never over- or under-claims. */
export const SIGMA_CAP = 22;

export function survivalSigma(expectedPick: number, dispersion: number): number {
  return Math.min(
    SIGMA_CAP,
    Math.max(
      SIGMA_FLOOR,
      SIGMA_BASE + SIGMA_SLOPE * Math.max(1, expectedPick) + SIGMA_DISP * Math.max(0, dispersion),
    ),
  );
}

/* --------------------------------------------------------------- Φ */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). Deterministic. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
/** P(D > x) for D ~ Normal(mu, sigma). */
function survN(mu: number, sigma: number, x: number): number {
  return clamp01(normalCdf((mu - x) / Math.max(1e-6, sigma)));
}

/* --------------------------------------------------------------- market snapshot */

export interface MarketEntry {
  player_id: string;
  /** robust market expected overall pick (S2 mu); null when no market row */
  expected_pick: number | null;
  /** source disagreement (MAD); null when unknown */
  dispersion: number | null;
  /** count of DIRECT_ADP sources behind `expected_pick` */
  direct_adp_count: number;
  /** market data quality for this player */
  confidence: MarketConfidence;
  /** legacy: average draft position, kept for callers that pass it directly */
  adp: number | null;
  /** Sleeper search_rank — the degraded-mode fallback signal */
  search_rank: number | null;
  /** [p10, p90] plausible pick band */
  pick_range: [number, number] | null;
}

export interface MarketSnapshot {
  by_player: Map<string, MarketEntry>;
  source: SurvivalSource;
  timestamp: string | null;
  /** count of players with a usable market signal */
  covered: number;
  /** count with ≥1 DIRECT_ADP source */
  direct_adp_covered: number;
  consensus_version: string;
  /** what the market layer degraded to, if anything */
  degraded_reason: string | null;
}

/**
 * Build the snapshot from the calibrated market consensus (`ri-snake-market`)
 * plus a per-player Sleeper `search_rank` map for degraded fallback.
 * Auction values are never ingested here (§5).
 */
export function buildMarketConsensusSnapshot(input: {
  searchRankByPlayer: Map<string, number | null>;
  referenceDate?: string;
  consensus?: MarketConsensusTable;
}): MarketSnapshot {
  const table = input.consensus ?? buildMarketConsensus({ referenceDate: input.referenceDate });
  const by_player = new Map<string, MarketEntry>();
  // coverage is measured over the DRAFT-RELEVANT zone (search_rank ≤ 200 or has
  // a market row) — not the full ~4k-player Sleeper universe, which would bury
  // the signal with deep bench / practice-squad records.
  let draftZone = 0;
  let directCovered = 0;
  let covered = 0;

  const ids = new Set<string>([...table.by_player.keys(), ...input.searchRankByPlayer.keys()]);
  for (const id of ids) {
    const c = table.by_player.get(id) ?? null;
    const sr = input.searchRankByPlayer.get(id) ?? null;
    const entry: MarketEntry = {
      player_id: id,
      expected_pick: c ? c.expected_pick : null,
      dispersion: c ? c.dispersion : null,
      direct_adp_count: c ? c.direct_adp_count : 0,
      confidence: c ? c.confidence : sr != null ? "LOW" : "NONE",
      adp: c ? c.expected_pick : null,
      search_rank: sr,
      pick_range: c ? c.pick_range : null,
    };
    if (c || sr != null) covered += 1;
    const inDraftZone = (c && c.direct_adp_count > 0) || (sr != null && sr <= 200);
    if (inDraftZone) draftZone += 1;
    if (c && c.direct_adp_count > 0) directCovered += 1;
    by_player.set(id, entry);
  }

  return {
    by_player,
    source: directCovered > 0 ? "ranking_pack_adp" : covered > 0 ? "sleeper_search_rank" : "positional_demand_only",
    timestamp: table.as_of_reference,
    covered: draftZone,
    direct_adp_covered: directCovered,
    consensus_version: table.version,
    degraded_reason:
      directCovered === 0
        ? "no DIRECT_ADP coverage — running on search_rank proxy only"
        : directCovered / Math.max(1, draftZone) < 0.6
          ? `partial DIRECT_ADP coverage (${directCovered}/${draftZone} of the draft zone) — deep-pool players fall back to search_rank`
          : null,
  };
}

/**
 * Legacy builder kept for tests / callers that hand-supply ADP + search_rank.
 */
export function buildMarketSnapshot(input: {
  adpByPlayer?: Map<string, number> | null;
  searchRankByPlayer: Map<string, number | null>;
  timestamp: string | null;
  dispersionByPlayer?: Map<string, number> | null;
}): MarketSnapshot {
  const by_player = new Map<string, MarketEntry>();
  const hasAdp = input.adpByPlayer && input.adpByPlayer.size > 0;
  let covered = 0;
  let directCovered = 0;
  const ids = new Set<string>([
    ...(input.adpByPlayer?.keys() ?? []),
    ...input.searchRankByPlayer.keys(),
  ]);
  for (const id of ids) {
    const adp = input.adpByPlayer?.get(id) ?? null;
    const sr = input.searchRankByPlayer.get(id) ?? null;
    const disp = input.dispersionByPlayer?.get(id) ?? null;
    if (adp != null || sr != null) covered += 1;
    if (adp != null) directCovered += 1;
    by_player.set(id, {
      player_id: id,
      expected_pick: adp,
      dispersion: disp,
      direct_adp_count: adp != null ? 1 : 0,
      confidence: adp != null ? "MEDIUM" : sr != null ? "LOW" : "NONE",
      adp,
      search_rank: sr,
      pick_range: null,
    });
  }
  return {
    by_player,
    source: hasAdp ? "ranking_pack_adp" : covered > 0 ? "sleeper_search_rank" : "positional_demand_only",
    timestamp: input.timestamp,
    covered,
    direct_adp_covered: directCovered,
    consensus_version: SURVIVAL_MODEL_VERSION,
    degraded_reason: hasAdp ? null : "no ADP supplied — search_rank proxy",
  };
}

/* --------------------------------------------------------------- estimate */

export interface SurvivalInput {
  playerId: string;
  position: FantasyPosition;
  /** the manager's NEXT pick (overall) — the survival horizon */
  targetPickOverall: number;
  /** picks by other teams between now and the target pick */
  interveningPicks: number;
  market: MarketSnapshot;
  /**
   * PHASE 5 (§16): the current overall pick. Survival is conditioned on the
   * player being available NOW — `P(D > k | D > currentPickOverall)`. Optional
   * for backward compatibility; when omitted the estimate is unconditional.
   */
  currentPickOverall?: number;
  /** extra picks-of-this-position expected from an active run (0 when none) */
  runExtraDemand?: number;
}

function mapConfidence(mc: MarketConfidence): SurvivalConfidence {
  return mc === "HIGH" ? "HIGH" : mc === "MEDIUM" ? "MEDIUM" : mc === "LOW" ? "LOW" : "UNAVAILABLE";
}

export function estimateSurvival(input: SurvivalInput): SurvivalEstimate {
  const entry = input.market.by_player.get(input.playerId);
  const now = input.market.timestamp;
  const k = input.targetPickOverall;
  const c = input.currentPickOverall ?? null;
  const runShift = Math.max(0, input.runExtraDemand ?? 0);

  // ---- S2: market distribution model (DIRECT_ADP present) --------------
  if (entry?.expected_pick != null) {
    const mu0 = entry.expected_pick;
    const sigma = survivalSigma(mu0, entry.dispersion ?? 0);
    // a live positional run pulls the effective market pick earlier
    const mu = mu0 - runShift;

    const uncond = (x: number) => survN(mu, sigma, x);
    // §17 conditional survival: re-base on "still here at pick c"
    const cond = (x: number): number => {
      if (c == null || c <= 1) return uncond(x);
      const denom = uncond(c);
      if (denom < 1e-4) return uncond(x); // player was already deep in the tail; nothing to condition on
      return clamp01(uncond(x) / denom);
    };

    const pNext = cond(k);
    const secondK = k + Math.max(1, input.interveningPicks);
    const pSecond = cond(secondK);

    const conf = mapConfidence(entry.confidence);
    return {
      p_survives_next_pick: round3(pNext),
      p_survives_second_next: round3(pSecond),
      expected_pick_window: entry.pick_range ?? [
        Math.max(1, Math.round(mu - 1.28 * sigma)),
        Math.round(mu + 1.28 * sigma),
      ],
      source: "ranking_pack_adp",
      confidence: conf,
      market_timestamp: now,
      note:
        `S2 market-distribution: D~N(${mu0.toFixed(1)}, ${sigma.toFixed(1)}²)` +
        (c != null ? `, conditioned on available at pick ${c}` : ", unconditional") +
        (runShift > 0 ? `, run shift −${runShift.toFixed(1)}` : "") +
        `; ${entry.direct_adp_count} direct ADP source(s), dispersion ${(entry.dispersion ?? 0).toFixed(1)}.`,
    };
  }

  // ---- degraded: search_rank proxy (LOW confidence heuristic) ----------
  // Deliberately NOT the calibrated S0 coefficients — S0 is the model Phase 5
  // replaces; its exact fit has poor discrimination and no place in production.
  // This is an honest wide fallback for the rare player with no ADP at all.
  if (entry?.search_rank != null) {
    const srPick = searchRankToPick(entry.search_rank) - runShift;
    const spread = 6 + 0.9 * Math.sqrt(Math.max(1, input.interveningPicks));
    const proxy = (T: number) => 1 / (1 + Math.exp((T - srPick) / spread));
    let pNext = proxy(k);
    let pSecond = proxy(k + Math.max(1, input.interveningPicks));
    if (c != null && c > 1) {
      const denom = proxy(c);
      if (denom > 1e-3) {
        pNext = clamp01(pNext / denom);
        pSecond = clamp01(pSecond / denom);
      }
    }
    return {
      p_survives_next_pick: round3(clamp01(pNext)),
      p_survives_second_next: round3(clamp01(pSecond)),
      expected_pick_window: [Math.max(1, Math.round(srPick - 1.5 * spread)), Math.round(srPick + 1.5 * spread)],
      source: "sleeper_search_rank",
      confidence: "LOW",
      market_timestamp: now,
      note:
        "Degraded: no DIRECT_ADP for this player — Sleeper search_rank proxy" +
        (c != null ? `, conditioned on available at pick ${c}` : "") +
        ". Low confidence (Brier ≈ 0.18 vs 0.11 for the calibrated ADP model).",
    };
  }

  // ---- no signal: demand-only ------------------------------------
  const spread = 4 + Math.sqrt(Math.max(1, input.interveningPicks));
  const p = 1 / (1 + Math.exp((k - (k - 8)) / spread));
  return {
    p_survives_next_pick: round3(clamp01(p)),
    p_survives_second_next: null,
    expected_pick_window: null,
    source: "positional_demand_only",
    confidence: "LOW",
    market_timestamp: now,
    note: "No market signal at all; wide demand-only estimate. Low confidence.",
  };
}

/**
 * §18 — TIER survival: `P(≥ 1 equivalent-tier player still available at pick k)`.
 *
 * Approximation status: SEMI-INDEPENDENT. Pure independence
 * (`1 − Π P(selected)`) over-estimates when the market is correlated, so we
 * blend it with an expected-demand logistic and pull toward the conservative
 * side. The blend weight was tuned on the Devoted-2026 draft
 * (`phase5_calibration_bins.csv`, tier rows).
 */
export function estimateTierSurvival(input: {
  position: FantasyPosition;
  tier: number;
  memberSurvival: number[];
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
  const pAnyIndependent = 1 - input.memberSurvival.reduce((acc, p) => acc * (1 - clamp01(p)), 1);
  const slack = n - input.expectedPositionDemand;
  const pDemand = 1 / (1 + Math.exp(-slack));
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
