/**
 * Phase 8 §14 / §15 — map a candidate into the audited common decision
 * dimensions WITHOUT pretending the underlying specialist numbers are the same
 * unit. Raw specialist scores (trade `roster_utility_delta`, waiver
 * `DecisionScore.total`, waiver `net_roster_gain`, projected lineup points,
 * Roster Health percentile, Schedule Planning loss, strategy urgency) are NEVER
 * compared directly — every candidate is translated here first.
 *
 * A dimension that cannot be quantified is marked `null` / `UNKNOWN`, never
 * fabricated.
 */

import type {
  ActionCost,
  ActionCostBand,
  CardinalEffect,
  CategoricalEffect,
  DecisionDimensions,
  EvidenceConfidence,
  Irreversibility,
  OrchestratorConfidence,
  OrchestratorHorizon,
  OrchestratorUrgency,
  TimingDegradationReason,
} from "./schema";

export const CONF_RANK: Record<OrchestratorConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const URGENCY_RANK: Record<OrchestratorUrgency, number> = {
  NOW: 0,
  THIS_WEEK: 1,
  BEFORE_WAIVERS: 2,
  NEAR_TERM: 3,
  FUTURE: 4,
  INFORMATIONAL: 5,
};
export const COST_RANK: Record<ActionCostBand, number> = { ZERO: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
export const MAGNITUDE_RANK = { NEGLIGIBLE: 0, MINOR: 1, MATERIAL: 2, MAJOR: 3, UNKNOWN: 0 } as const;

export function minConfidence(...cs: OrchestratorConfidence[]): OrchestratorConfidence {
  return cs.reduce((a, b) => (CONF_RANK[b] < CONF_RANK[a] ? b : a), "HIGH");
}

export function pointsEffect(
  value: number | null,
  source: string,
  opts: { basis?: CardinalEffect["basis"]; horizon?: OrchestratorHorizon; perWeek?: boolean } = {},
): CardinalEffect {
  return {
    value: value != null && Number.isFinite(value) ? Math.round(value * 100) / 100 : null,
    unit: opts.perWeek ? "fantasy_points_per_week" : "fantasy_points",
    source,
    basis: opts.basis,
    horizon: opts.horizon,
  };
}

export function categorical(
  direction: CategoricalEffect["direction"],
  magnitude_class: CategoricalEffect["magnitude_class"],
  source: string,
): CategoricalEffect {
  return { direction, magnitude_class, source };
}

/**
 * Timing band from ACTUAL data only (P8-1). `NOW` is reserved for a truly
 * current structural condition (illegal lineup / empty starter slot / a starter
 * on a schedule-verified bye) — never inferred from a kickoff time we do not
 * have.
 */
export function classifyUrgency(input: {
  isCurrentStructuralDefect?: boolean;
  needsWaiverClaim?: boolean;
  waiverDayKnown?: boolean;
  futureWeeksAway?: number | null;
  isPlayoffWindow?: boolean;
  seasonUrgency?: number | null; // strategy urgency [0,1]
  informationalOnly?: boolean;
}): { urgency: OrchestratorUrgency; timing_degradation: TimingDegradationReason[] } {
  const deg: TimingDegradationReason[] = [];
  if (input.informationalOnly) return { urgency: "INFORMATIONAL", timing_degradation: deg };
  if (input.isCurrentStructuralDefect) {
    // A current structural defect deserves attention this week; we cannot say
    // "before tonight" because no lock/kickoff fact exists.
    deg.push("EXACT_LOCK_TIME_UNAVAILABLE");
    return { urgency: "NOW", timing_degradation: deg };
  }
  if (input.needsWaiverClaim) {
    if (!input.waiverDayKnown) deg.push("WAIVER_DAY_UNKNOWN");
    return { urgency: "BEFORE_WAIVERS", timing_degradation: deg };
  }
  const away = input.futureWeeksAway ?? null;
  if (away != null) {
    if (away <= 0) return { urgency: "THIS_WEEK", timing_degradation: deg };
    if (away <= 3) return { urgency: "NEAR_TERM", timing_degradation: deg };
    return { urgency: "FUTURE", timing_degradation: deg };
  }
  // default current-week concern with no finer signal
  deg.push("EXACT_LOCK_TIME_UNAVAILABLE");
  return { urgency: "THIS_WEEK", timing_degradation: deg };
}

export function lineupCost(freeSwap: boolean): ActionCost {
  return freeSwap
    ? { band: "LOW", consumes: null, reasons: ["free legal lineup change — no roster/priority/FAAB consumed"] }
    : { band: "LOW", consumes: null, reasons: ["lineup reshuffle — no transaction cost"] };
}

export function waiverCost(input: {
  requiresDrop: boolean;
  dropName: string | null;
  waiverType: "faab" | "rolling" | "reverse_standings" | "unknown";
  openSlot: boolean;
}): ActionCost {
  const reasons: string[] = [];
  let consumes: string | null = null;
  if (input.waiverType === "faab") {
    consumes = "faab";
    reasons.push("consumes FAAB");
  } else if (input.waiverType === "rolling" || input.waiverType === "reverse_standings") {
    consumes = "waiver_priority";
    reasons.push("consumes waiver priority");
  } else {
    reasons.push("waiver mechanism unknown — cost is qualitative");
  }
  if (input.requiresDrop) {
    reasons.push(`requires dropping ${input.dropName ?? "a rostered player"}`);
    return { band: "MEDIUM", consumes: consumes ?? "roster_slot", reasons };
  }
  if (input.openSlot) {
    reasons.push("open roster slot — no drop required");
    return { band: input.waiverType === "unknown" ? "LOW" : "MEDIUM", consumes, reasons };
  }
  return { band: "MEDIUM", consumes: consumes ?? "roster_slot", reasons };
}

export function tradeExplorationCost(): ActionCost {
  return {
    band: "HIGH",
    consumes: "roster_asset",
    reasons: ["trades exchange assets, require partner acceptance, and are effectively irreversible once executed"],
  };
}

export function irreversibilityOf(kind: "LINEUP" | "WAIVER" | "TRADE_EXPLORATION", requiresDrop: boolean): Irreversibility {
  if (kind === "LINEUP") return "REVERSIBLE";
  if (kind === "TRADE_EXPLORATION") return "IRREVERSIBLE";
  return requiresDrop ? "PARTLY_REVERSIBLE" : "PARTLY_REVERSIBLE";
}

export function buildEvidenceConfidence(input: {
  projectionBasis: EvidenceConfidence["projection_basis"];
  dataQuality: string;
  specialistConfidence: string;
  horizon: OrchestratorHorizon;
}): EvidenceConfidence {
  // Derive a confidence floor from the weakest observable signal.
  let floor: OrchestratorConfidence = "HIGH";
  const sc = input.specialistConfidence.toUpperCase();
  if (sc.includes("LOW") || sc.includes("PROVISIONAL") || sc.includes("UNRESOLVED") || sc.includes("ROS_CONTEXT_ONLY") || sc.includes("NON_VIABLE") || sc.includes("DEGRADED")) {
    floor = "LOW";
  } else if (sc.includes("MEDIUM") || sc.includes("MODERATE") || input.projectionBasis === "ROS_PROJECTION") {
    floor = "MEDIUM";
  }
  const dq = input.dataQuality.toUpperCase();
  if (dq !== "READY" && dq !== "OK" && dq !== "") {
    floor = floor === "HIGH" ? "MEDIUM" : "LOW";
  }
  if (input.projectionBasis === "NONE") floor = "LOW";
  return {
    projection_basis: input.projectionBasis,
    data_quality: input.dataQuality,
    specialist_confidence: input.specialistConfidence,
    horizon: input.horizon,
    floor,
  };
}

export function assembleDimensions(input: {
  expected_weekly_effect: CardinalEffect | null;
  risk_reduction: CategoricalEffect | CardinalEffect | null;
  urgency: OrchestratorUrgency;
  timing_degradation: TimingDegradationReason[];
  evidence_confidence: EvidenceConfidence;
  cost: ActionCost;
  irreversibility: Irreversibility;
}): DecisionDimensions {
  // Action confidence is capped by the evidence floor — ranking first never
  // upgrades confidence (§22).
  const confidence = input.evidence_confidence.floor;
  return {
    expected_weekly_effect: input.expected_weekly_effect,
    risk_reduction: input.risk_reduction,
    urgency: input.urgency,
    timing_degradation: input.timing_degradation,
    confidence,
    evidence_confidence: input.evidence_confidence,
    cost: input.cost,
    irreversibility: input.irreversibility,
  };
}
