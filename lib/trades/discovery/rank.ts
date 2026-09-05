/**
 * Trade Engine — Phase 4H: ranking and explanation.
 *
 * `discovery_score` is built ONLY from Phase 1/2 authoritative fields already
 * computed by `evaluateTrade` (`roster_utility_delta` / `contextual_utility_delta`),
 * plus a transparent complexity penalty and a small viability bonus. Phase 3
 * shadow fields (`phase3.*`) are read here ONLY to populate the
 * `phase3_shadow` explanation block — never added into `discovery_score`.
 * That separation is the Phase 4 calibration rule made concrete.
 */

import type { CandidatePackage } from "./types";
import type { TradeDiscoveryResult, SearchMode } from "./types";
import type { EvaluatedCandidate } from "./candidate-eval";
import { acceptanceAtLeast, partnerAcceptanceFloor } from "./config";

const COMPLEXITY_PENALTY_PER_ASSET_BEYOND_TWO = 0.15;

/** Reads the AUTHORITATIVE utility for one participant — contextual (Phase 2) when present, else Phase 1. Never Phase 3. */
function authoritativeUtility(r: { roster_utility_delta: number; phase2?: { contextual_utility_delta: number } | undefined }): number {
  return r.phase2 ? r.phase2.contextual_utility_delta : r.roster_utility_delta;
}
function authoritativeAcceptance(r: { acceptance: string; phase2?: { contextual_acceptance: string } | undefined }): string {
  return r.phase2 ? r.phase2.contextual_acceptance : r.acceptance;
}

export function buildRationale(myResult: { starter_points_delta: number | null; positional_need_changes: Array<{ position: string; kind: string }>; lineup_displacement: { entered_starting_lineup: string[]; left_starting_lineup: string[] }; phase2?: { depth: { fragility_delta: number } } | undefined }): string[] {
  const out: string[] = [];
  if (myResult.starter_points_delta != null && myResult.starter_points_delta > 0) out.push(`Starting lineup improves by ${myResult.starter_points_delta.toFixed(1)} projected points this week.`);
  const improved = myResult.positional_need_changes.filter((c) => c.kind === "IMPROVES_NEED").map((c) => c.position);
  if (improved.length > 0) out.push(`Improves positional need at: ${improved.join(", ")}.`);
  if (myResult.lineup_displacement.entered_starting_lineup.length > 0) out.push(`${myResult.lineup_displacement.entered_starting_lineup.length} acquired player(s) enter the starting lineup.`);
  if (myResult.phase2 && myResult.phase2.depth.fragility_delta > 0) out.push(`Roster fragility improves (${myResult.phase2.depth.fragility_delta.toFixed(1)}).`);
  if (myResult.phase2 && myResult.phase2.depth.fragility_delta < -1) out.push(`Note: roster fragility worsens (${(-myResult.phase2.depth.fragility_delta).toFixed(1)}) — depth cost of this deal.`);
  if (out.length === 0) out.push("Marginal roster change — see full_evaluation for exact deltas.");
  return out;
}

export function buildPartnerRationale(partnerResult: { starter_points_delta: number | null; positional_need_changes: Array<{ position: string; kind: string }> }): string[] {
  const out: string[] = [];
  const improved = partnerResult.positional_need_changes.filter((c) => c.kind === "IMPROVES_NEED").map((c) => c.position);
  if (improved.length > 0) out.push(`Fills their need at: ${improved.join(", ")}.`);
  if (partnerResult.starter_points_delta != null && partnerResult.starter_points_delta > 0) out.push(`Their starting lineup also improves (${partnerResult.starter_points_delta.toFixed(1)} pts).`);
  return out;
}

/**
 * Builds one `TradeDiscoveryResult` from an already-evaluated candidate.
 * Returns `null` if the candidate doesn't meet the mode's acceptance/utility
 * policy — filtering happens HERE, once, in one documented place.
 */
export function buildDiscoveryResult(
  myManagerSlug: string,
  pkg: CandidatePackage,
  evaluated: EvaluatedCandidate,
  mode: SearchMode,
  partnerFitScore: number | null,
  minimumMyUtility: number | undefined,
  minimumPartnerUtility: number | undefined,
): TradeDiscoveryResult | null {
  if (!evaluated.ok || !evaluated.evaluation) return null;
  const ev = evaluated.evaluation;
  // evaluateTrade keys `participants` by manager_slug (see lib/trades/evaluate.ts) — match on that directly, no heuristic.
  const entries = Object.values(ev.participants);
  const mine = entries.find((r) => r.manager_slug === myManagerSlug);
  if (!mine) return null;
  const others = entries.filter((r) => r !== mine);

  const myUtility = authoritativeUtility(mine);
  if (minimumMyUtility != null && myUtility < minimumMyUtility) return null;

  const floor = partnerAcceptanceFloor(mode);
  for (const o of others) {
    const acc = authoritativeAcceptance(o);
    if (!acceptanceAtLeast(acc, floor)) return null;
    const u = authoritativeUtility(o);
    if (minimumPartnerUtility != null && u < minimumPartnerUtility) return null;
  }

  const complexity = pkg.transfers.length;
  // discovery_score itself is computed once, centrally, in `rankResults` below —
  // this function only decides whether a candidate SURVIVES to be ranked at all.

  const minPartnerGain = others.length > 0 ? Math.min(...others.map(authoritativeUtility)) : myUtility;

  const shadowWarnings: string[] = [];
  if (mine.phase3) {
    if (mine.phase3.divergence_reason) shadowWarnings.push(mine.phase3.divergence_reason);
    for (const attr of mine.phase3.player_attribution) {
      if (attr.uncertainty === "HIGH") shadowWarnings.push(`${attr.canonical_player_id}: HIGH volatility (shadow signal, not scored).`);
    }
    if (mine.phase3.confidence === "LOW" || mine.phase3.confidence === "DEGRADED") shadowWarnings.push(`Phase 3 confidence: ${mine.phase3.confidence} (${mine.phase3.confidence_reasons.join("; ")}).`);
  }

  return {
    rank: 0, // assigned by caller after sorting
    shape: pkg.shape,
    transfers: pkg.transfers,
    participants: entries.map((r) => ({ manager_id: r.manager_slug, manager_slug: r.manager_slug, utility_delta: authoritativeUtility(r), acceptance: authoritativeAcceptance(r) as never })),
    my_gain: myUtility,
    minimum_partner_gain: minPartnerGain,
    trade_viability: ev.trade_summary.trade_viability,
    rationale: [...buildRationale(mine), ...others.flatMap((o) => buildPartnerRationale(o))],
    phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE", warnings: shadowWarnings },
    search_metadata: { mode, complexity, partner_fit: partnerFitScore },
    full_evaluation: { trade_summary: ev.trade_summary, phase2_summary: ev.phase2_summary, phase3_summary: ev.phase3_summary, participants: ev.participants },
  };
}

/** Sorts by discovery_score (recomputed from my_gain/complexity for a stable, explicit ordering) descending, deterministic tie-break. */
export function rankResults(results: TradeDiscoveryResult[]): TradeDiscoveryResult[] {
  const scored = results.map((r) => ({
    r,
    score: r.my_gain + (r.trade_viability === "HIGH" ? 0.25 : r.trade_viability === "MODERATE" ? 0.1 : 0) - Math.max(0, r.search_metadata.complexity - 2) * COMPLEXITY_PENALTY_PER_ASSET_BEYOND_TWO,
  }));
  scored.sort((a, b) => b.score - a.score || a.r.transfers.length - b.r.transfers.length || JSON.stringify(a.r.transfers).localeCompare(JSON.stringify(b.r.transfers)));
  return scored.map((s, i) => ({ ...s.r, rank: i + 1 }));
}
