/**
 * Decision Model Convergence — W1.P1: Canonical Weekly Player Forecast contract.
 *
 * ONE structured answer to "what does Bloodline Bowl believe this player is worth for
 * this NFL week, why, with what uncertainty, and based on what evidence?".
 *
 * W1.P1 is a substrate phase. It RE-EXPRESSES the value production already uses; it does
 * not change it. Specifically (and pinned by tests):
 *   - `expected_points` is the production weekly value, bit-for-bit (the post-bye-override
 *     `WeeklyProjection.projected_points` in `WeeklyTeamContext.projections`).
 *   - `conditional_active_points` defaults to the source projection (no injury math yet — W1.P2).
 *   - role / environment / matchup are SHADOW or INFORMATIONAL only. Nothing here can be PRODUCTION.
 *
 * Semantics that must never be conflated (each has its own field/state):
 *   BYE  != injury  != missing data  != zero projection
 *   source projection != Bloodline expected projection
 *   confidence != projected points
 *   current-week utility != ROS asset value (this object is current-week utility only)
 *   null = unknown, 0 = known zero.
 */

import type { PlayerIdentifiers } from "@/lib/canonical/schema";

export const CANONICAL_WEEKLY_FORECAST_VERSION = "canonical-weekly-forecast-2026.1" as const;

/**
 * Why the numbers look the way they do. Exactly one per forecast. Numeric 0 is NEVER used as a
 * universal error/null: only KNOWN_ZERO_PROJECTION and BYE_VERIFIED carry a 0 `expected_points`.
 */
export type ForecastValueState =
  /** Source published a real stat line that scored to a non-zero number. */
  | "PROJECTED"
  /** Source published a real stat line that scores to exactly 0: a known zero, real data. */
  | "KNOWN_ZERO_PROJECTION"
  /** Schedule-proven bye. `expected_points = 0` is a COMPAT PLACEHOLDER, not "no underlying value". */
  | "BYE_VERIFIED"
  /** Authoritative schedule says the team plays no game and it is not a bye. Reserved: needs caller-supplied schedule facts. */
  | "NO_SCHEDULED_GAME"
  /** Source marked the player not playing (gp = 0). Value unknown, never fabricated. */
  | "PLAYER_OUT_IN_SOURCE"
  /** Identity did not resolve; no forecast can be attached to a canonical player. */
  | "PLAYER_NOT_FOUND"
  /** The source batch is healthy but has no entry for this player. */
  | "SOURCE_MISSING_PLAYER"
  /** The whole source fetch failed (PROJECTIONS_UNAVAILABLE). */
  | "SOURCE_FETCH_FAILURE"
  /** Source row exists but only carries precomputed totals the league scoring cannot reconstruct. */
  | "UNSUPPORTED_SCORING_DATA"
  /** Source row exists but produced no usable number for another reason. */
  | "PROJECTION_UNAVAILABLE"
  /** Cannot be classified (defensive default). */
  | "UNKNOWN";

/** How `expected_points` was obtained. */
export type ExpectedPointsBasis =
  | "SOURCE_PROJECTION"
  /** 0 substituted for a verified bye so existing lineup/waiver math is unchanged (W1.P3 owns the real fix). */
  | "BYE_COMPAT_ZERO"
  /** A production FI adjustment is baked into the value; the pre-adjustment source value is not recoverable. */
  | "SOURCE_PLUS_FI_PRODUCTION"
  | "UNKNOWN";

export type ComponentMode = "NOT_APPLIED" | "INFORMATIONAL" | "SHADOW" | "PRODUCTION";
export type ContributionMode = "INFORMATIONAL" | "SHADOW" | "PRODUCTION";

/** What a contribution is ABOUT. One PRODUCTION entry per phenomenon (validated) so nothing adjusts the same thing twice. */
export type ContributionPhenomenon =
  | "BASE"
  | "BYE"
  | "ROLE"
  | "ENVIRONMENT"
  | "MATCHUP"
  | "AVAILABILITY"
  | "FOOTBALL_INTELLIGENCE";

export interface ForecastContribution {
  component: string;
  phenomenon: ContributionPhenomenon;
  points_delta: number;
  mode: ContributionMode;
  reason?: string;
}

export type AvailabilityStatus =
  | "ACTIVE"
  | "QUESTIONABLE"
  | "DOUBTFUL"
  | "OUT"
  | "INJURED_RESERVE"
  | "SUSPENDED_OR_OTHER"
  | "BYE"
  | "UNKNOWN";

export type CertificationState = "PRODUCTION" | "SHADOW" | "PARTIAL" | "UNAVAILABLE";

export interface CanonicalWeeklyPlayerForecast {
  model_version: typeof CANONICAL_WEEKLY_FORECAST_VERSION;
  canonical_player_id: string;
  /** Provider-neutral. Provider ids are descriptive only; no logic may require one. */
  identifiers: PlayerIdentifiers;
  season: number;
  week: number;
  team: string | null;
  opponent: string | null;
  position: string | null;

  value_state: ForecastValueState;

  game_status: {
    /** null = unknown. false only when proven (bye / no game). */
    has_game: boolean | null;
    is_bye: boolean;
    game_id: string | null;
    kickoff_at: string | null;
  };

  projection: {
    /** The upstream provider's projection for this player-week, in league scoring. null = unknown (NOT zero). */
    source_points: number | null;
    /**
     * Value if the player is healthy/active and plays. W1.P1: defaults to `source_points`. It deliberately does NOT
     * collapse to 0 on a bye — a bye player's underlying value stays visible here (or null if the source had none).
     */
    conditional_active_points: number | null;
    /** The value production consumes for current-week decisions. See `expected_points_basis`. */
    expected_points: number | null;
    expected_points_basis: ExpectedPointsBasis;
    floor: number | null;
    median: number | null;
    ceiling: number | null;
  };

  availability: {
    /** Heuristic chance of being active from injury designation. null = unknown or bye (a bye is not an injury). */
    probability_active: number | null;
    status: AvailabilityStatus;
    injury_status: string | null;
    workload_state: string | null;
    /** W1.P1 invariant: availability is metadata only and is NOT applied to `expected_points`. W1.P2 flips this. */
    applied_to_expected_points: false;
    basis: "injury_status_heuristic" | "bye_schedule" | "none";
  };

  role: ForecastComponent<{ state: unknown; adjustment_points: number; confidence: number | null }>;
  environment: ForecastComponent<{ adjustment_points: number; confidence: number | null }>;
  matchup: ForecastComponent<{ adjustment_points: number; confidence: number | null }>;

  uncertainty: {
    confidence: number | null;
    variance: number | null;
    /** `source_distribution` | `position_volatility_heuristic` | `none` — a heuristic band is not a fitted distribution. */
    basis: string;
    reasons: string[];
  };

  freshness: {
    /** When the upstream source itself was observed. Not captured by the current provider -> null (W1.P4). */
    source_observed_at: string | null;
    snapshot_created_at: string | null;
    age_ms: number | null;
    /** null = age unknown. */
    stale: boolean | null;
  };

  provenance: {
    projection_provider: string | null;
    /** The provider's own model version (e.g. `sleeper-weekly-rotowire`). */
    source_version: string | null;
    source_type: "WEEKLY_STAT_LINE_SCORED" | "K_DST_STANDARD_FALLBACK" | "BYE_SCHEDULE" | "NONE";
    snapshot: { artifact_id: string | null; read_path: string | null; durable: boolean | null };
    source_ids: Record<string, string>;
    /** Components whose delta is inside `expected_points`. */
    production_adjustments_applied: string[];
    /** Components computed but NOT inside `expected_points`. */
    shadow_adjustments_computed: string[];
    /** Raw upstream per-player warning codes, preserved verbatim. */
    source_warnings: string[];
  };

  /**
   * Ledger. Invariant (validated): the sum of PRODUCTION deltas equals `expected_points` (null expected -> no PRODUCTION
   * entries). SHADOW / INFORMATIONAL entries never enter that sum.
   */
  contributions: ForecastContribution[];

  certification: {
    state: CertificationState;
    warnings: string[];
  };
}

export interface ForecastComponent<T> {
  mode: ComponentMode;
  /** Present only when a signal was supplied. */
  signal: T | null;
}

export interface CanonicalWeeklyForecastBatch {
  model_version: typeof CANONICAL_WEEKLY_FORECAST_VERSION;
  league_slug: string;
  season: number;
  week: number;
  source: string;
  source_version: string;
  by_player: Map<string, CanonicalWeeklyPlayerForecast>;
  counts: {
    total: number;
    by_value_state: Partial<Record<ForecastValueState, number>>;
    by_certification: Partial<Record<CertificationState, number>>;
    bye: number;
    with_shadow_signal: number;
  };
}

/** Optional per-player shadow/informational evidence. The type forbids PRODUCTION on purpose (W1.P1 promotes nothing). */
export interface ShadowSignalInput<T> {
  mode: "SHADOW" | "INFORMATIONAL";
  signal: T;
  /** Human-readable reason carried into the ledger. */
  reason?: string;
}

export interface ForecastShadowSignals {
  role?: ShadowSignalInput<{ state: unknown; adjustment_points: number; confidence: number | null }>;
  environment?: ShadowSignalInput<{ adjustment_points: number; confidence: number | null }>;
  matchup?: ShadowSignalInput<{ adjustment_points: number; confidence: number | null }>;
}
