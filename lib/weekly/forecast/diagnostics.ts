/**
 * Machine-readable per-player diagnostics: answers "why does production use this number for this player?" without prose parsing.
 */

import type { CanonicalWeeklyPlayerForecast, ForecastComponent } from "./schema";
import { validateForecastInvariants } from "./validate";

export interface ForecastDiagnostic {
  model_version: string;
  canonical_player_id: string;
  week: number;
  value_state: CanonicalWeeklyPlayerForecast["value_state"];
  source_points: number | null;
  expected_points: number | null;
  expected_points_basis: CanonicalWeeklyPlayerForecast["projection"]["expected_points_basis"];
  /** Why expected_points is what it is, as a stable code. */
  expected_points_reason: string;
  is_bye: boolean;
  availability: { status: string; probability_active: number | null; injury_status: string | null; applied_to_expected_points: false };
  source_age_ms: number | null;
  source_stale: boolean | null;
  role: { available: boolean; mode: string; adjustment_points: number | null; applied_to_expected_points: boolean };
  environment: { available: boolean; mode: string; adjustment_points: number | null; applied_to_expected_points: boolean };
  matchup: { available: boolean; mode: string; adjustment_points: number | null; applied_to_expected_points: boolean };
  provider: string | null;
  source_version: string | null;
  certification: CanonicalWeeklyPlayerForecast["certification"];
  invariant_violations: string[];
}

const REASONS: Record<CanonicalWeeklyPlayerForecast["projection"]["expected_points_basis"], string> = {
  SOURCE_PROJECTION: "EXPECTED_EQUALS_SOURCE_PROJECTION_NO_ADJUSTMENT_APPLIED",
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
  return {
    model_version: f.model_version,
    canonical_player_id: f.canonical_player_id,
    week: f.week,
    value_state: f.value_state,
    source_points: f.projection.source_points,
    expected_points: f.projection.expected_points,
    expected_points_basis: f.projection.expected_points_basis,
    expected_points_reason: REASONS[f.projection.expected_points_basis],
    is_bye: f.game_status.is_bye,
    availability: {
      status: f.availability.status,
      probability_active: f.availability.probability_active,
      injury_status: f.availability.injury_status,
      applied_to_expected_points: f.availability.applied_to_expected_points,
    },
    source_age_ms: f.freshness.age_ms,
    source_stale: f.freshness.stale,
    role: comp(f.role),
    environment: comp(f.environment),
    matchup: comp(f.matchup),
    provider: f.provenance.projection_provider,
    source_version: f.provenance.source_version,
    certification: f.certification,
    invariant_violations: validateForecastInvariants(f),
  };
}
