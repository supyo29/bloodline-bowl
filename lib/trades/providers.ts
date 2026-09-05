/**
 * Trade Engine — Phase 3.5B/C: pluggable usage & schedule data providers.
 *
 * No real source is wired in this environment (no network access to any
 * usage-stats or opponent-adjusted schedule-strength API — see the Phase 3.5
 * readiness report, `docs/TRADE_ENGINE_PHASE35_DATA_READINESS.md`, for the
 * source-evaluation work that would precede actually integrating one). This
 * module defines the INTERFACE a future real provider must satisfy, plus the
 * `NULL_*_PROVIDER` that is the ONLY implementation registered anywhere in
 * this repo today — every method returns "no data". This lets a real
 * provider be plugged into `buildPlayerIntelligence` (`lib/trades/
 * intelligence.ts`) later without touching Phase 3's evaluation logic at all,
 * while today's behavior is byte-identical to before this file existed:
 * usage/role/trend/schedule stay honestly UNAVAILABLE.
 *
 * Per the Phase 3.5 guiding principle, even if a real provider is plugged in
 * later, its output feeds `PlayerIntelligence` DIAGNOSTICS ONLY — it is never
 * wired into `shadow_utility_delta` (see `lib/trades/phase3.ts`, which
 * hardcodes `role_adjustment`/`schedule_adjustment` to `0` regardless of what
 * intelligence data is available). A signal earns a nonzero weight only after
 * clearing `lib/trades/data-readiness.ts`'s calibration-readiness gate.
 */

/* -------------------------------------------------------------------------- */
/* Usage / opportunity                                                        */
/* -------------------------------------------------------------------------- */

export type UsageFreshness = "CURRENT" | "STALE" | "PARTIAL" | "UNKNOWN";

export interface PlayerUsageSnapshot {
  player_id: string;
  season: number;
  week: number;
  snaps: number | null;
  snap_share: number | null;
  routes: number | null;
  route_participation: number | null;
  targets: number | null;
  target_share: number | null;
  carries: number | null;
  rush_share: number | null;
  red_zone_targets: number | null;
  red_zone_carries: number | null;
  goal_line_carries: number | null;
  source: string;
  updated_at: string;
  freshness: UsageFreshness;
}

export interface UsageProvider {
  readonly source_name: string;
  /** The most recent usage snapshot available for a player, or null if none exists. */
  getCurrentUsage(playerId: string): PlayerUsageSnapshot | null;
  /**
   * Usage AS OF a given season/week — for historical reconstruction. Must
   * never return a snapshot from a LATER week than requested (a real
   * implementation is responsible for its own no-look-ahead discipline; see
   * `lib/trades/historical.ts`'s `assertNoLookahead` for the trade-level guard).
   */
  getHistoricalUsage(playerId: string, season: number, week: number): PlayerUsageSnapshot | null;
  /** Up to `weeksBack` most-recent snapshots, oldest first, for trend detection. May return fewer than requested (or none). */
  getRecentUsageSeries(playerId: string, weeksBack: number): PlayerUsageSnapshot[];
}

export const NULL_USAGE_PROVIDER: UsageProvider = {
  source_name: "none (no usage-stats source integrated in this environment)",
  getCurrentUsage: () => null,
  getHistoricalUsage: () => null,
  getRecentUsageSeries: () => [],
};

export type UsageTrend = "IMPROVING" | "STABLE" | "DECLINING" | "VOLATILE" | "INSUFFICIENT_DATA";

/** A share reading is only usable for trend detection above this sample size (routes/snaps/carries, whichever the position uses). Below this, a single week is noise, not signal. */
export const MIN_USAGE_SAMPLE_SIZE = 10;
/** Fewer than this many usable weeks -> no directional claim is made at all. */
export const MIN_WEEKS_FOR_TREND = 3;
/** A recent-window standard deviation above this (as a share, 0..1) is VOLATILE, not a directional trend. */
const VOLATILITY_STD_THRESHOLD = 0.15;
/** Minimum mean shift between baseline and recent windows to call a direction (not noise). */
const TREND_SHIFT_THRESHOLD = 0.08;

/**
 * Conservative trend classifier over a caller-supplied usage-share series
 * (oldest first). Generic and pure — has no knowledge of WHERE the series
 * came from, so it behaves identically once a real provider exists. Shrinks
 * toward `STABLE`/`INSUFFICIENT_DATA` rather than overreacting to one big
 * week — the "hot-hand trap" the Phase 3.5 spec names explicitly.
 */
export function classifyUsageTrend(weeklyShares: Array<{ share: number | null; sample_size: number | null }>): UsageTrend {
  const usable = weeklyShares.filter(
    (w): w is { share: number; sample_size: number } => w.share != null && w.sample_size != null && w.sample_size >= MIN_USAGE_SAMPLE_SIZE,
  );
  if (usable.length < MIN_WEEKS_FOR_TREND) return "INSUFFICIENT_DATA";
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const recent = usable.slice(-MIN_WEEKS_FOR_TREND);
  const baseline = usable.slice(0, -MIN_WEEKS_FOR_TREND);
  const recentMean = mean(recent.map((w) => w.share));
  const recentStd = Math.sqrt(mean(recent.map((w) => (w.share - recentMean) ** 2)));
  if (recentStd > VOLATILITY_STD_THRESHOLD) return "VOLATILE";
  if (baseline.length === 0) return "STABLE"; // not enough history to call a DIRECTION — never infers a trend from the recent window alone
  const baselineMean = mean(baseline.map((w) => w.share));
  const delta = recentMean - baselineMean;
  if (delta > TREND_SHIFT_THRESHOLD) return "IMPROVING";
  if (delta < -TREND_SHIFT_THRESHOLD) return "DECLINING";
  return "STABLE";
}

/* -------------------------------------------------------------------------- */
/* Schedule strength                                                          */
/* -------------------------------------------------------------------------- */

export type ScheduleFreshness = "CURRENT" | "STALE" | "UNAVAILABLE";

export interface PlayerScheduleContext {
  player_id: string;
  week: number;
  opponent: string;
  position: string;
  /** higher = easier matchup; caller-defined scale, must be documented by the real provider when one exists */
  matchup_score: number | null;
  /** 0..1, this matchup's percentile among all matchups that week at the position */
  matchup_percentile: number | null;
  source: string;
  updated_at: string;
  freshness: ScheduleFreshness;
}

export interface ScheduleProvider {
  readonly source_name: string;
  getWeeklyMatchup(playerId: string, week: number): PlayerScheduleContext | null;
}

export const NULL_SCHEDULE_PROVIDER: ScheduleProvider = {
  source_name: "none (no opponent-adjusted schedule-strength source integrated in this environment)",
  getWeeklyMatchup: () => null,
};

/** A schedule effect can never move a player's value by more than this fraction of their own weekly projection — an extreme matchup cannot turn a low-role player into a premium asset. */
const SCHEDULE_ADJUSTMENT_CAP_FRACTION_OF_PROJECTION = 0.15;

/**
 * Bounds a schedule-quality adjustment to a fraction of the player's own
 * weekly projection (Phase 3.5 §14). Pure and generic — not wired to any real
 * matchup score today, and not consumed by `computeShadowUtility` (schedule
 * intelligence stays diagnostic-only in Phase 3.5; see the module doc above).
 */
export function capScheduleAdjustment(rawAdjustment: number, weeklyProjection: number | null): number {
  if (weeklyProjection == null || !Number.isFinite(rawAdjustment) || !Number.isFinite(weeklyProjection)) return 0;
  const cap = Math.abs(weeklyProjection) * SCHEDULE_ADJUSTMENT_CAP_FRACTION_OF_PROJECTION;
  return Math.max(-cap, Math.min(cap, rawAdjustment));
}
