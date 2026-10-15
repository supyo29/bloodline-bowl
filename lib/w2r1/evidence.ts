/**
 * W2.R1 canonical point-in-time evidence contract (provider neutral).
 *
 * Rules enforced by `validateAsset` / `validateFeature` (and mutation-tested):
 *  - no modeled feature exists without provenance (source, observed_at, model/source version);
 *  - UNKNOWN is never 0: a null value must carry a missing-evidence reason, and a numeric value must not;
 *  - a verified bye contributes EXACTLY 0 to this week's lineup but keeps its underlying (hold) value in other weeks;
 *  - every asset carries a scoring fingerprint and confidence.
 * Availability (injury) is owned by Wave 1: this layer consumes `WeekValue.lineup` (already availability-aware) and never discounts again.
 */
export type Pos = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
export const POSITIONS: readonly Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type RosterStatus = "STARTER" | "BENCH" | "IR" | "PUP" | "NFI" | "RESERVE";
export type WeekState = "ACTIVE" | "BYE" | "OUT" | "UNKNOWN";

export interface Provenance {
  source: string;
  /** when W2.R1 observed it */
  observed_at: string;
  /** when the source published it (null = not exposed) */
  source_at: string | null;
  /** milliseconds between source_at/observed_at and the evaluation instant (null = unknown) */
  evidence_age_ms: number | null;
  version: string;
}

export interface WeekValue {
  state: WeekState;
  /** expected points if started this week, AVAILABILITY-AWARE (Wave 1 expected_points). BYE/OUT => exactly 0. UNKNOWN => null (never 0). */
  lineup: number | null;
  /** value of the asset in this week if healthy and playing (hold basis). Bye weeks have no game => 0. null = unknown. */
  underlying: number | null;
}

export interface AssetEvidence {
  player_id: string;
  name: string;
  position: Pos;
  eligible_positions: Pos[];
  team: string | null;
  scoring_fingerprint: string;
  /** week -> value. Missing week = unknown (never zero-filled). */
  weeks: Record<number, WeekValue>;
  bye_week: number | null;
  confidence: Confidence;
  provenance: Provenance;
  /** reason any week is unknown / identity unresolved etc. */
  missing_evidence: string[];
}

export interface RosterAsset extends AssetEvidence {
  status: RosterStatus;
  /** first week an IR/PUP/NFI/RESERVE player may be activated; null = not returnable */
  returns_in_week: number | null;
}

export interface Acquisition {
  method: "FREE_AGENT_ADD" | "WAIVER_CLAIM";
  /** probability the add succeeds. FREE_AGENT_ADD verified-addable = 1; WAIVER_CLAIM competition unknown => null (never invented). */
  success_probability: number | null;
  faab_cost: number | null;
  waiver_priority: number | null;
  /** first week the player is acquirable (game-lock aware); null = unknown */
  available_from_week: number | null;
}

export interface MarketCandidate extends AssetEvidence { acquisition: Acquisition }

export interface MarketPool {
  provider: "sleeper" | "yahoo";
  /** true only when availability came from a verified provider status (certified market state) */
  verified: boolean;
  observed_at: string | null;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  candidates: MarketCandidate[];
}

export interface LeagueRules {
  league_id: string;
  scoring_fingerprint: string;
  /** starting slot labels, e.g. QB RB RB WR WR TE FLEX K DEF (Sleeper and Yahoo flex labels both supported) */
  slots: string[];
  bench_size: number;
  ir_slots: number;
  teams: number | null;
  /** last regular-season week considered by ROS */
  last_week: number;
}

export interface Feature {
  name: string;
  value: number | null;
  unknown_reason: string | null;
  provenance: Provenance | null;
}

export function validateFeature(f: Feature): string[] {
  const out: string[] = [];
  if (!f.provenance) out.push(`feature ${f.name}: missing provenance`);
  else for (const k of ["source", "observed_at", "version"] as const) if (!f.provenance[k]) out.push(`feature ${f.name}: provenance.${k} missing`);
  if (f.value == null && !f.unknown_reason) out.push(`feature ${f.name}: unknown value without a missing-evidence reason`);
  if (f.value != null && f.unknown_reason) out.push(`feature ${f.name}: numeric value must not carry an unknown reason`);
  if (f.value != null && !Number.isFinite(f.value)) out.push(`feature ${f.name}: non-finite value`);
  return out;
}

export function validateAsset(a: AssetEvidence): string[] {
  const out: string[] = [];
  if (!a.player_id) out.push("asset: missing player_id");
  if (!a.scoring_fingerprint) out.push(`${a.player_id}: missing scoring fingerprint`);
  if (!a.confidence) out.push(`${a.player_id}: missing confidence`);
  if (!a.provenance || !a.provenance.source || !a.provenance.observed_at || !a.provenance.version) out.push(`${a.player_id}: missing provenance`);
  for (const [w, v] of Object.entries(a.weeks)) {
    const tag = `${a.player_id} week ${w}`;
    if (v.state === "BYE" && v.lineup !== 0) out.push(`${tag}: a bye must contribute exactly 0 to the lineup`);
    if (v.state === "BYE" && v.underlying !== 0) out.push(`${tag}: a bye week has no game (underlying 0)`);
    if (v.state === "OUT" && v.lineup !== 0) out.push(`${tag}: an OUT week contributes exactly 0 to the lineup`);
    if (v.state === "UNKNOWN" && v.lineup !== null) out.push(`${tag}: UNKNOWN must be null, never a number`);
    if (v.state === "ACTIVE" && v.lineup === null) out.push(`${tag}: ACTIVE requires a lineup value (else state UNKNOWN)`);
    if (v.lineup != null && !Number.isFinite(v.lineup)) out.push(`${tag}: non-finite lineup`);
    if (v.underlying != null && !Number.isFinite(v.underlying)) out.push(`${tag}: non-finite underlying`);
  }
  const unknownWeeks = Object.values(a.weeks).some((v) => v.state === "UNKNOWN");
  if (unknownWeeks && a.missing_evidence.length === 0) out.push(`${a.player_id}: unknown week(s) without a missing-evidence reason`);
  return out;
}

export function validateMarket(m: MarketPool): string[] {
  const out: string[] = [];
  for (const c of m.candidates) {
    out.push(...validateAsset(c));
    const p = c.acquisition.success_probability;
    if (p != null && (p < 0 || p > 1)) out.push(`${c.player_id}: acquisition probability out of range`);
    if (c.acquisition.method === "WAIVER_CLAIM" && p === 1) out.push(`${c.player_id}: a waiver claim must never be assumed guaranteed`);
  }
  return out;
}
