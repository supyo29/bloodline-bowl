/**
 * Machine-readable per-player diagnostics: answers "why does production use this number for this player?" without prose parsing.
 */

import type { CanonicalWeeklyPlayerForecast, ForecastComponent } from "./schema";
import { validateForecastInvariants } from "./validate";

export interface ForecastDiagnostic {
  model_version: string;
  injury_model_version: string;
  canonical_player_id: string;
  week: number;
  value_state: CanonicalWeeklyPlayerForecast["value_state"];
  /** What the source projected. */
  source_points: number | null;
  /** Value if active (derived under the chosen source semantics). */
  conditional_active_points: number | null;
  /** The value decisions use. */
  expected_points: number | null;
  expected_points_basis: CanonicalWeeklyPlayerForecast["projection"]["expected_points_basis"];
  expected_points_reason: string;
  is_bye: boolean;
  injury: {
    /** what the provider reported, verbatim */
    source_status: string | null;
    /** how Bloodline interpreted it */
    normalized_state: string;
    availability_state: string;
    probability_active: number | null;
    workload_if_active: { expected_fraction: number | null; lower_bound: number | null; upper_bound: number | null; basis: string };
    source_projection_injury_semantics: string;
    /** λ: share of injury risk assumed already inside the source; null if no discount math ran */
    embedded_fraction_assumed: number | null;
    availability_delta: number;
    workload_delta: number;
    adjustment_points: number;
    mode: string;
    applied_to_expected_points: boolean;
    confidence: number | null;
    calibration: Record<string, string>;
    evidence: Record<string, unknown>;
    reasons: string[];
    warnings: string[];
  };
  /** W1.P4: everything needed to answer "how current is this, relative to kickoff, and why?" */
  freshness: CanonicalWeeklyPlayerForecast["freshness"] & { time_until_kickoff_ms: number | null };
  /** the provider's own fixed heuristic, shown so it can be compared with the model's P(active) */
  source_heuristic_availability: number | null;
  source_age_ms: number | null;
  source_stale: boolean | null;
  role: { available: boolean; mode: string; adjustment_points: number | null; applied_to_expected_points: boolean };
  environment: { available: boolean; mode: string; adjustment_points: number | null; applied_to_expected_points: boolean };
  matchup: { available: boolean; mode: string; adjustment_points: number | null; applied_to_expected_points: boolean };
  provider: string | null;
  source_version: string | null;
  certification: CanonicalWeeklyPlayerForecast["certification"];
  /** every production/shadow ledger line, so the final number is reconstructable */
  ledger: CanonicalWeeklyPlayerForecast["contributions"];
  invariant_violations: string[];
}

const REASONS: Record<CanonicalWeeklyPlayerForecast["projection"]["expected_points_basis"], string> = {
  SOURCE_PROJECTION: "EXPECTED_EQUALS_SOURCE_PROJECTION_NO_ADJUSTMENT_APPLIED",
  CONDITIONAL_ACTIVE_X_AVAILABILITY: "SOURCE_CONDITIONAL_ON_ACTIVE_TIMES_P_ACTIVE",
  SOURCE_ALREADY_INJURY_ADJUSTED: "SOURCE_ALREADY_EMBEDS_INJURY_RISK_NO_SECOND_DISCOUNT",
  SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT: "SOURCE_EMBEDS_PART_OF_INJURY_RISK_REMAINDER_APPLIED",
  SOURCE_WITH_LIMITED_WORKLOAD_ADJUSTMENT: "SOURCE_WITH_EXPLICIT_WORKLOAD_EVIDENCE_APPLIED",
  UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT: "STATUS_UNRECOGNISED_OR_UNSUPPORTED_NO_DISCOUNT",
  OFFICIAL_UNAVAILABLE_KNOWN_ZERO: "KNOWN_UNAVAILABLE_RESOLVES_TO_KNOWN_ZERO_SOURCE_VISIBLE",
  BYE_COMPAT_ZERO: "VERIFIED_BYE_COMPAT_ZERO_NOT_UNDERLYING_VALUE",
  SOURCE_PLUS_FI_PRODUCTION: "SOURCE_PLUS_CERTIFIED_FI_PRODUCTION_ADJUSTMENT",
  UNKNOWN: "NO_VALUE_UNKNOWN_NOT_ZERO",
};

const comp = (c: ForecastComponent<{ adjustment_points: number }>) => ({
  available: c.signal != null,
  mode: c.mode,
  adjustment_points: c.signal ? c.signal.adjustment_points : null,
  applied_to_expected_points: c.mode === "PRODUCTION",
});

export function explainForecast(f: CanonicalWeeklyPlayerForecast): ForecastDiagnostic {
  const im = f.injury_model;
  return {
    model_version: f.model_version,
    injury_model_version: im.model_version,
    canonical_player_id: f.canonical_player_id,
    week: f.week,
    value_state: f.value_state,
    source_points: f.projection.source_points,
    conditional_active_points: f.projection.conditional_active_points,
    expected_points: f.projection.expected_points,
    expected_points_basis: f.projection.expected_points_basis,
    expected_points_reason: REASONS[f.projection.expected_points_basis],
    is_bye: f.game_status.is_bye,
    injury: {
      source_status: im.source_status,
      normalized_state: im.normalized_state,
      availability_state: im.availability_state,
      probability_active: im.probability_active,
      workload_if_active: im.workload_if_active,
      source_projection_injury_semantics: im.source_projection_injury_semantics,
      embedded_fraction_assumed: im.embedded_fraction_assumed,
      availability_delta: im.availability_delta,
      workload_delta: im.workload_delta,
      adjustment_points: im.adjustment_points,
      mode: im.mode,
      applied_to_expected_points: f.availability.applied_to_expected_points,
      confidence: im.confidence,
      calibration: im.calibration,
      evidence: im.evidence,
      reasons: im.reasons,
      warnings: im.warnings,
    },
    freshness: { ...f.freshness, time_until_kickoff_ms: f.freshness.ms_to_kickoff },
    source_heuristic_availability: f.availability.source_heuristic_availability,
    source_age_ms: f.freshness.age_ms,
    source_stale: f.freshness.stale,
    role: comp(f.role),
    environment: comp(f.environment),
    matchup: comp(f.matchup),
    provider: f.provenance.projection_provider,
    source_version: f.provenance.source_version,
    certification: f.certification,
    ledger: f.contributions,
    invariant_violations: validateForecastInvariants(f),
  };
}
