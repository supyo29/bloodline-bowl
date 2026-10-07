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
import type { InjuryModelResult } from "./injury-model";
import type { ForecastSetIdentity } from "../freshness/identity";

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
  /**
   * Known unavailable this week (designation Out / IR / PUP / NFI / SUS / DNR, or an official game-day inactive). `expected_points`
   * is a KNOWN ZERO; the source projection stays visible in `source_points`. Distinct from a bye and from missing data.
   */
  | "KNOWN_UNAVAILABLE"
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
  /** W1.P2: source is conditional on playing; expected = source × P(active) (× workload if evidenced). */
  | "CONDITIONAL_ACTIVE_X_AVAILABILITY"
  /** W1.P2: source believed to already embed injury risk; NO second discount. */
  | "SOURCE_ALREADY_INJURY_ADJUSTED"
  /** W1.P2: source embeds part of the risk (assumed when its semantics are unknown); only the remaining risk is applied. */
  | "SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT"
  | "SOURCE_WITH_LIMITED_WORKLOAD_ADJUSTMENT"
  /** W1.P2: status unrecognised / unsupported: source value kept, no invented certainty. */
  | "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT"
  /** W1.P2: designation or official evidence makes the player unavailable: known zero. */
  | "OFFICIAL_UNAVAILABLE_KNOWN_ZERO"
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
  /** metadata only: a designation was recorded but nothing was applied */
  | "AVAILABILITY"
  | "INJURY_AVAILABILITY"
  | "INJURY_WORKLOAD"
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

  /**
   * W1.P3: the CURRENT-WEEK utility question, kept apart from the asset question. `current_week_points` always equals
   * `projection.expected_points`; for a verified bye it is a known 0 while `underlying_points_if_game_played` keeps the
   * player's football value (never the bye zero).
   */
  weekly_value: {
    current_week_points: number | null;
    current_week_state: "PLAYABLE" | "BYE" | "OUT" | "UNKNOWN" | "KNOWN_ZERO";
    /** value if he had a game under comparable role/health; null = unknown (never fabricated as 0) */
    underlying_points_if_game_played: number | null;
    underlying_basis: "SOURCE_PROJECTION" | "SOURCE_PROJECTION_PRE_BYE" | "ROS_PER_WEEK_PROXY" | "UNAVAILABLE";
  };

  /** W1.P3: why current-week value may differ from asset value. Decision layers (drop/keep) read this, never infer it from a zero. */
  asset_context: {
    /** BYE wins when both apply (the current week IS a bye); the injury designation stays in `injury_model`. */
    temporary_unavailability_reason: "BYE" | "INJURY" | null;
    /** true when current_week_points is 0 only because of the bye */
    bye_suppressed_current_week: boolean;
    /** true when an underlying/forward value exists to hold against (not a calibrated asset valuation) */
    forward_value_available: boolean;
  };

  availability: {
    /**
     * P(active) from the W1.P2 injury model. null = unknown (unrecognised status, or a bye — a bye is not an injury).
     * Participation only: workload-if-active lives in `injury_model.workload_if_active`.
     */
    probability_active: number | null;
    /** Coarse status for display/back-compat. */
    status: AvailabilityStatus;
    /** What the PROVIDER reported, verbatim (never normalised away — F1). */
    injury_status: string | null;
    /** How Bloodline interpreted it. */
    normalized_state: string;
    availability_state: string;
    workload_state: string | null;
    /** The provider's own fixed availability heuristic, retained as provenance only (this is what W1.P1 reported as probability_active). */
    source_heuristic_availability: number | null;
    /** true only when the injury model changed `expected_points` (PRODUCTION mode and a non-zero delta / known-unavailable). */
    applied_to_expected_points: boolean;
    basis: "injury_model" | "bye_schedule" | "none";
  };

  /** W1.P2 injury model output: source vs normalized status, P(active), workload, semantics guard, calibration state, evidence. */
  injury_model: InjuryModelResult;

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

  /**
   * W1.P4 freshness. The four times are distinct: `source_observed_at` (Bloodline fetched the upstream state), `snapshot_created_at`
   * (a snapshot pointer was written — NEVER a substitute for the source time), `forecast_composed_at`, and the kickoff/event instants.
   * All TTL arithmetic lives in `freshness/policy.ts`; consumers read `state`, they do not recompute it.
   */
  freshness: {
    source_observed_at: string | null;
    snapshot_created_at: string | null;
    forecast_composed_at: string | null;
    /** now − source_observed_at; null when either is unknown */
    age_ms: number | null;
    /** back-compat: true iff `state === "STALE"`; null when freshness is UNKNOWN */
    stale: boolean | null;
    state: "FRESH" | "STALE" | "UNKNOWN" | "FROZEN_PREGAME";
    policy: { version: string; tier: string; required_max_age_ms: number | null; reason: string };
    kickoff_at: string | null;
    ms_to_kickoff: number | null;
    invalidation_reasons: string[];
    refresh: { attempted: boolean; succeeded: boolean | null; failed_at: string | null; reason: string | null };
    /** machine-derived explanation for users; null when nothing needs saying */
    user_warning: string | null;
    source_observation_id: string | null;
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
  /** W1.P4: the evidence set this whole batch rests on (league + scoring + source observation + snapshot). Set by the context builder. */
  identity?: ForecastSetIdentity;
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
