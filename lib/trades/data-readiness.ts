/**
 * Trade Engine — Phase 3.5F: calibration readiness classification.
 *
 * This module does NOT assign production weights and does NOT infer
 * readiness from a formula — every classification below is a hand-set,
 * documented judgment call (mirroring `CONCEPTUAL_OVERLAP_MATRIX` in
 * `lib/trades/calibration.ts`, which is the same kind of static audit
 * artifact). It exists so "is this signal ready to calibrate?" has one
 * answerable, versioned place instead of being re-litigated per phase.
 *
 * Per the Phase 3.5 guiding principle: prefer NO SIGNAL over BAD SIGNAL, and
 * WEIGHT = 0 over UNJUSTIFIED CALIBRATION. A signal is `READY_FOR_CALIBRATION`
 * only once ALL of `MinimumSampleRequirements`' dimensions are met AND no
 * `blocking_reason` remains — today NONE of the six signals below clears that
 * bar, because this environment has zero real historical trades and zero
 * real usage/schedule providers registered (see `lib/trades/providers.ts`).
 */

/**
 * Phase 3.5 data-enablement layer version. Bump on any change to the
 * provider-framework contract (`lib/trades/providers.ts`), the safety-cleanup
 * surfaces (D2-D5), or this readiness classification. Does NOT track Phase
 * 3's VALUE contract — see `TRADE_CALIBRATED_VERSION` in `lib/trades/phase3.ts`
 * for that; `shadow_utility_delta`'s formula is unchanged by Phase 3.5.
 */
export const TRADE_DATA_LAYER_VERSION = "ri-trade-data-2026.1" as const;

export type SignalReadiness = "READY_FOR_CALIBRATION" | "SHADOW_ONLY" | "INSUFFICIENT_DATA" | "REJECTED";

export interface MinimumSampleRequirements {
  historical_trades: number;
  player_weeks: number;
  players: number;
  leagues: number;
  seasons: number;
}

/**
 * Thresholds are deliberately conservative and documented, not tuned: a
 * single-league, single-season sample cannot support a claim of
 * generalizable calibration (Phase 3.5 §33/§34). These are floors to even
 * BEGIN considering a signal ready, not a guarantee of readiness on their own.
 */
export const MINIMUM_SAMPLE_REQUIREMENTS: MinimumSampleRequirements = {
  historical_trades: 50,
  player_weeks: 500,
  players: 100,
  leagues: 3,
  seasons: 2,
};

export interface SignalReadinessEntry {
  signal: string;
  status: SignalReadiness;
  sample_size: Partial<MinimumSampleRequirements>;
  coverage_note: string;
  historical_support: "NONE" | "PARTIAL" | "FULL";
  leakage_risk: "NONE" | "LOW" | "MODERATE" | "HIGH";
  redundancy_risk: "NONE" | "LOW" | "MODERATE" | "HIGH";
  blocking_reason: string | null;
  recommendation: string;
}

/**
 * The current, real state of every Phase 3 signal in THIS repository, as of
 * the Phase 3.5 audit. Update this table (with justification) as real data is
 * actually integrated — do not flip a status without also updating
 * `docs/TRADE_ENGINE_PHASE35_DATA_READINESS.md`'s evidence for it.
 */
export const SIGNAL_READINESS: SignalReadinessEntry[] = [
  {
    signal: "availability",
    status: "SHADOW_ONLY",
    sample_size: { historical_trades: 0, players: 0 },
    coverage_note: "Source-backed today (canonical_player.injury_status + current-week expected_availability) for every rostered player in a live league snapshot. No synthetic scenario or real trade count is tracked here — availability isn't a calibration TARGET, it's a data-quality input.",
    historical_support: "NONE",
    leakage_risk: "LOW",
    redundancy_risk: "MODERATE",
    blocking_reason: "No historical trade dataset exists to validate that an availability-based value adjustment (as opposed to the current diagnostic-only exposure) would improve directional accuracy over Phase 1/2 alone.",
    recommendation: "Keep diagnostic-only (feeds `confidence`, never `shadow_utility_delta`) until a historical-outcome dataset exists to test an adjustment against.",
  },
  {
    signal: "volatility",
    status: "SHADOW_ONLY",
    sample_size: { historical_trades: 0, players: 0 },
    coverage_note: "Source-backed today (weekly std_dev CV + RI/external ROS disagreement). Feeds `valuation_range` and `confidence` only.",
    historical_support: "NONE",
    leakage_risk: "LOW",
    redundancy_risk: "MODERATE",
    blocking_reason: "Conceptual overlap with `roster_fragility` (see `CONCEPTUAL_OVERLAP_MATRIX`) is not yet empirically resolved against real outcomes, and no historical dataset exists to do so.",
    recommendation: "Keep diagnostic-only. Re-evaluate once a historical dataset exists and `runAblation` can be run against real outcomes.",
  },
  {
    signal: "usage_trend",
    status: "INSUFFICIENT_DATA",
    sample_size: { player_weeks: 0, players: 0 },
    coverage_note: "No real usage-stats provider is registered anywhere in this repo (`NULL_USAGE_PROVIDER` everywhere) — `classifyUsageTrend` exists and is unit-tested, but has never run against a single real player-week.",
    historical_support: "NONE",
    leakage_risk: "LOW",
    redundancy_risk: "LOW",
    blocking_reason: "No usage-stats source has been integrated (source evaluation not started — see docs/TRADE_ENGINE_PHASE35_DATA_READINESS.md §Data sources).",
    recommendation: "Do NOT calibrate. First integrate a real, evaluated source; then accumulate enough player-weeks to clear MINIMUM_SAMPLE_REQUIREMENTS before even considering a shadow value adjustment.",
  },
  {
    signal: "role_stability",
    status: "INSUFFICIENT_DATA",
    sample_size: { player_weeks: 0, players: 0 },
    coverage_note: "Derived from the same (currently null) usage series as usage_trend — inherits the same blocker.",
    historical_support: "NONE",
    leakage_risk: "LOW",
    redundancy_risk: "MODERATE",
    blocking_reason: "Same as usage_trend: no real usage provider registered.",
    recommendation: "Same as usage_trend.",
  },
  {
    signal: "schedule_strength",
    status: "INSUFFICIENT_DATA",
    sample_size: { player_weeks: 0, players: 0 },
    coverage_note: "No opponent-adjusted schedule-strength provider is registered (`NULL_SCHEDULE_PROVIDER` everywhere). `capScheduleAdjustment` exists and is unit-tested as a bounding mechanism, but has never bounded a real matchup score.",
    historical_support: "NONE",
    leakage_risk: "LOW",
    redundancy_risk: "LOW",
    blocking_reason: "No schedule-strength source has been integrated (source evaluation not started).",
    recommendation: "Do NOT calibrate. First integrate and evaluate a real source.",
  },
  {
    signal: "historical_trade_outcome",
    status: "INSUFFICIENT_DATA",
    sample_size: { historical_trades: 0, leagues: 0, seasons: 0 },
    coverage_note: "The retrospective framework (`lib/trades/historical.ts`) and a counterfactual generator (`lib/trades/historical-counterfactual.ts`) exist and are tested, but hold ZERO real records — no network access to pull real completed Bloodline Bowl (or any other league's) transaction history in this environment.",
    historical_support: "NONE",
    leakage_risk: "LOW",
    redundancy_risk: "NONE",
    blocking_reason: "Zero real historical trades ingested. Real trades alone would also carry selection bias (Phase 3.5 §20) even once ingested — a counterfactual sample is required alongside them, not instead of them.",
    recommendation: "This is the hard blocker for calibrating ANY Phase 3 signal, not just this one — every other signal's readiness ultimately depends on having real outcomes to validate against.",
  },
];

export interface CalibrationReadinessReport {
  generated_at: string;
  minimum_sample_requirements: MinimumSampleRequirements;
  signals: SignalReadinessEntry[];
  any_signal_ready: boolean;
  hard_blockers: string[];
}

/** Assembles the full readiness report — pure, deterministic, no I/O. */
export function buildCalibrationReadinessReport(generatedAt: string = new Date().toISOString()): CalibrationReadinessReport {
  const hardBlockers = SIGNAL_READINESS.filter((s) => s.status !== "READY_FOR_CALIBRATION" && s.blocking_reason).map(
    (s) => `${s.signal}: ${s.blocking_reason}`,
  );
  return {
    generated_at: generatedAt,
    minimum_sample_requirements: MINIMUM_SAMPLE_REQUIREMENTS,
    signals: SIGNAL_READINESS,
    any_signal_ready: SIGNAL_READINESS.some((s) => s.status === "READY_FOR_CALIBRATION"),
    hard_blockers: hardBlockers,
  };
}
