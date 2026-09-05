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
 * `blocking_reason` remains.
 *
 * COMPLETION-PASS UPDATE: real data now exists (see
 * `docs/TRADE_ENGINE_PHASE35_COMPLETION.md`) — 1 real completed Sleeper trade
 * (`scripts/ingest-sleeper-historical-trades.ts`), 6,037 real 2025-season
 * player-weeks of usage (`analysis/phase35_usage_pipeline.R`), and 2,176 real
 * 2025-season schedule-matchup rows (`analysis/phase35_schedule_pipeline.R`).
 * NONE of the six signals below clears `MINIMUM_SAMPLE_REQUIREMENTS` even so
 * — 1 historical trade is nowhere near 50, and the real usage/schedule data
 * is 2025 BACKTEST data, not live 2026 data (the 2026 season has played zero
 * games as of this pass) — but the counts below are now REAL, not zero.
 */

/**
 * Phase 3.5 data-enablement layer version. Bump on any change to the
 * provider-framework contract (`lib/trades/providers.ts`), the safety-cleanup
 * surfaces (D2-D5), the real-data ingestion pipelines, or this readiness
 * classification. Does NOT track Phase 3's VALUE contract — see
 * `TRADE_CALIBRATED_VERSION` in `lib/trades/phase3.ts` for that;
 * `shadow_utility_delta`'s formula is unchanged by Phase 3.5.
 *   2026.1 — framework-complete pass (NULL providers only, 0 real data).
 *   2026.2 — completion pass: real Sleeper trade ingestion, real R usage/
 *            schedule pipelines, real file-backed providers with a
 *            structural as-of-week look-ahead guard. Still NOT wired as any
 *            default — the live `POST /api/trades/analyze` path is untouched.
 */
export const TRADE_DATA_LAYER_VERSION = "ri-trade-data-2026.2" as const;

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
    sample_size: { player_weeks: 6037, players: 6031, seasons: 1 },
    coverage_note: "REAL as of the completion pass: `analysis/phase35_usage_pipeline.R` pulled 6,037 real 2025-season player-weeks (18 weeks, QB/RB/WR/TE) from nflverse via nflreadr, 6,031 resolved to a sleeper_id via `nflreadr::load_ff_playerids`. `createRUsageProviderAsOf` (lib/trades/r-data-providers.ts) is a real, tested, file-backed `UsageProvider` with a structural as-of-week look-ahead guard — but it is 2025 BACKTEST data (2026 has played 0 games) and is NOT wired as any default provider.",
    historical_support: "PARTIAL",
    leakage_risk: "LOW",
    redundancy_risk: "LOW",
    blocking_reason: "1 season, 1-2 leagues of real usage data is far below MINIMUM_SAMPLE_REQUIREMENTS' `seasons: 2` / `leagues: 3` floor, and there is no real historical TRADE outcome to validate a usage-trend-based adjustment against (only 1 real trade exists total — see historical_trade_outcome).",
    recommendation: "Genuinely closer than before, but still do NOT calibrate. Re-run the R pipeline once the 2026 season has played games (real current-season data), pull additional prior seasons, and — critically — wait for a usable historical-outcome sample before any ablation against real trade outcomes is possible.",
  },
  {
    signal: "role_stability",
    status: "INSUFFICIENT_DATA",
    sample_size: { player_weeks: 6037, players: 6031, seasons: 1 },
    coverage_note: "Derived from the same real usage series as usage_trend (`classifyUsageTrend` over `getRecentUsageSeries`) — inherits its real sample size and the same blocker.",
    historical_support: "PARTIAL",
    leakage_risk: "LOW",
    redundancy_risk: "MODERATE",
    blocking_reason: "Same as usage_trend: real usage data exists now, but no real trade-outcome sample exists to validate a role-stability-based adjustment against.",
    recommendation: "Same as usage_trend.",
  },
  {
    signal: "schedule_strength",
    status: "INSUFFICIENT_DATA",
    sample_size: { player_weeks: 2176, seasons: 1 },
    coverage_note: "REAL as of the completion pass: `analysis/phase35_schedule_pipeline.R` produced 2,176 real 2025-season team+opponent+position+week matchup rows (points-allowed-by-position, percentile-normalized to [-1,+1] — a documented, simpler proxy, not an EPA-adjusted metric). `createRScheduleProviderAsOf` is a real, tested, file-backed `ScheduleProvider` with the same structural as-of-week guard. A real cross-signal check (`scripts/phase35-real-correlation-check.ts`) found LOW correlation with actual usage (target_share x matchup_score: n=6037, pearson=0.107, spearman=0.088; rush_share x matchup_score: pearson=0.009) — i.e. real usage does not already track schedule ease, so the signal is not obviously redundant with usage on this evidence.",
    historical_support: "PARTIAL",
    leakage_risk: "LOW",
    redundancy_risk: "LOW",
    blocking_reason: "No real trade-outcome sample exists to test whether a schedule-based adjustment would have predicted anything real; K/DST are not modeled at all (QB/RB/WR/TE only).",
    recommendation: "Genuinely closer than before. Do NOT calibrate — the low observed usage-correlation is a mild positive signal for non-redundancy, not evidence of predictive value, which still requires real outcomes to test.",
  },
  {
    signal: "historical_trade_outcome",
    status: "INSUFFICIENT_DATA",
    sample_size: { historical_trades: 1, leagues: 2, seasons: 2 },
    coverage_note: "REAL as of the completion pass: `scripts/ingest-sleeper-historical-trades.ts` scanned every registered Sleeper league (bloodline-bowl 2026; devoted-to-the-game 2026 and 2025, walking `previous_league_id`) and found exactly **1 real completed trade** (Devoted to the Game, 2025, week 4, 2 participants, both assets supported PLAYER transfers, pre-trade ownership fully reconstructed via chronological transaction replay from the 2025 draft). `outcome` is `null` for this record — no realized post-trade outcome was computed this pass (future work). The retrospective framework and counterfactual generator both ran successfully against this real record.",
    historical_support: "PARTIAL",
    leakage_risk: "LOW",
    redundancy_risk: "NONE",
    blocking_reason: "1 real trade (2 leagues scanned, only 1 with any Sleeper history at all) is dramatically below the 50-trade floor, and it has no computed outcome yet regardless. This remains THE hard blocker every other signal's readiness ultimately depends on.",
    recommendation: "Not a data-pipeline problem anymore — it is a population-size problem. Bloodline Bowl is a brand-new league with no Sleeper history; Devoted to the Game has 2 seasons but managers simply haven't made many trades. Compute real outcomes for this 1 trade, keep re-scanning as both leagues age, and lean on the (real, working) counterfactual generator to build a larger — but explicitly labeled COUNTERFACTUAL, never REAL — sample in parallel.",
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
