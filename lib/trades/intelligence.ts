/**
 * Trade Engine — Phase 3B (+ Phase 3.5B/C provider wiring): player intelligence layer.
 *
 * A structured, source-backed context layer for individual players. The
 * project has NO live in-season usage-stats feed and no opponent-adjusted
 * schedule-strength source registered anywhere today (see
 * `docs/TRADE_ENGINE_PHASE35_DATA_READINESS.md` for the source-evaluation
 * work that would precede integrating one) — the only usage-component data in
 * the repo lives in `lib/projections/*`, the PRESEASON Roster Intel draft
 * model, which Phase 1/2 already documented as "not a defensible
 * opponent-specific WEEKLY projection" and consume only ORDINALLY. Per the
 * Phase 3 mandate ("do not invent unavailable statistics"), usage/role/trend/
 * schedule are honestly `UNAVAILABLE` with a diagnostic whenever no provider
 * is registered — never a fabricated number.
 *
 * What IS genuinely source-backed and is populated for real, unconditionally:
 *   - availability: `CanonicalPlayer.injury_status` + the current-week
 *     `WeeklyProjection.expected_availability` (Phase 1's own inputs).
 *   - volatility: the current-week projection's `std_dev` (coefficient of
 *     variation) plus the existing RI-vs-external ROS disagreement signal
 *     (`RosSignal.disagreement_pct` / `.confidence`) — both already computed
 *     upstream, reused here rather than re-derived.
 *
 * Usage/role/trend/schedule are now PLUGGABLE (Phase 3.5): `buildPlayerIntelligence`
 * accepts an optional `providers` argument (`lib/trades/providers.ts`). No
 * caller in this repo passes a non-null provider today — `DEFAULT_PROVIDERS`
 * (the `NULL_*_PROVIDER`s) is used everywhere, so behavior is unchanged from
 * before this file existed. The wiring exists so a REAL provider can be
 * registered later without touching Phase 3's evaluation logic, and is
 * exercised end-to-end by tests using a synthetic stub provider.
 *
 * IMPORTANT: even if a real provider is registered, its output feeds
 * `PlayerIntelligence` DIAGNOSTICS ONLY. `lib/trades/phase3.ts` hardcodes
 * `role_adjustment`/`schedule_adjustment` to `0` regardless of what
 * intelligence is available — a signal earns a value adjustment only after
 * clearing `lib/trades/data-readiness.ts`'s calibration-readiness gate.
 *
 * This module NEVER decides player value. It only describes what is known
 * about a player so the confidence layer (Phase 3C) and any future calibrated
 * adjustment (Phase 3D, currently weight 0) can consume it.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection } from "@/lib/weekly/schema";
import type { TradeAnalysisContext } from "./context";
import type { TradeDiagnostic } from "./schema";
import {
  NULL_USAGE_PROVIDER,
  NULL_SCHEDULE_PROVIDER,
  classifyUsageTrend,
  MIN_USAGE_SAMPLE_SIZE,
  type UsageProvider,
  type ScheduleProvider,
  type PlayerUsageSnapshot,
  type PlayerScheduleContext,
  type UsageTrend,
} from "./providers";

export type DataFreshness = "CURRENT" | "STALE" | "UNAVAILABLE";
/**
 * Audit D2 fix: `"RETURNING"` was previously declared here but never
 * assigned by `classifyAvailability` — an unreachable enum value that
 * overstated capability (no source in this repo distinguishes "recently
 * returned from injury" from any other status string). Removed rather than
 * faked; a just-cleared player now correctly reads as whatever its real raw
 * injury-status string says (typically `HEALTHY`).
 */
export type AvailabilityStatus =
  | "HEALTHY"
  | "QUESTIONABLE"
  | "DOUBTFUL"
  | "OUT"
  | "IR"
  | "PUP"
  | "SUSPENDED"
  | "UNKNOWN";
export type VolatilityLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type RoleStability = "STABLE" | "IMPROVING" | "DECLINING" | "VOLATILE" | "UNCERTAIN";

export interface SignalMeta {
  source: string;
  /** ISO timestamp of the underlying data, when the source carries one. */
  updated_at: string | null;
  freshness: DataFreshness;
}

export interface AvailabilityIntelligence {
  status: AvailabilityStatus;
  /** 0..1 from the current-week projection; null when no projection exists. */
  expected_availability: number | null;
  raw_injury_status: string | null;
  meta: SignalMeta;
}

export interface VolatilityIntelligence {
  level: VolatilityLevel;
  /** std_dev / projected_points for the CURRENT week (a weekly-only proxy — documented limitation). */
  weekly_coefficient_of_variation: number | null;
  /** |RI season model − external season model| as a fraction of external (already computed upstream). */
  ros_disagreement_pct: number | null;
  ros_confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  meta: SignalMeta;
}

/** No provider is registered for this signal (or the registered provider has nothing for this player). */
export interface UnavailableSignal {
  status: "UNAVAILABLE";
  reason: string;
}
export interface AvailableUsageSignal {
  status: "AVAILABLE";
  snapshot: PlayerUsageSnapshot;
  /** true when the snapshot's own sample size is below `MIN_USAGE_SAMPLE_SIZE` — still reported, never suppressed, but flagged. */
  small_sample: boolean;
}
export type UsageSignal = UnavailableSignal | AvailableUsageSignal;

export interface AvailableRoleSignal {
  status: "AVAILABLE";
  stability: RoleStability;
  trend: UsageTrend;
  weeks_observed: number;
}
export type RoleSignal = (UnavailableSignal & { stability: "UNCERTAIN" }) | AvailableRoleSignal;

export interface AvailableTrendSignal {
  status: "AVAILABLE";
  trend: UsageTrend;
}
export type TrendSignal = UnavailableSignal | AvailableTrendSignal;

export interface AvailableScheduleSignal {
  status: "AVAILABLE";
  context: PlayerScheduleContext;
}
export type ScheduleSignal = UnavailableSignal | AvailableScheduleSignal;

export interface PlayerIntelligence {
  canonical_player_id: string;
  availability: AvailabilityIntelligence;
  volatility: VolatilityIntelligence;
  /** Phase 3B usage/opportunity signal (snap share, target share, carry share, etc.) */
  usage: UsageSignal;
  /** Phase 3B role-stability classification */
  role: RoleSignal;
  /** Phase 3B trend detection (usage_trend, target_share_trend, ...) */
  trend: TrendSignal;
  /** Phase 3B schedule context (remaining_schedule_quality, playoff_schedule_quality) */
  schedule: ScheduleSignal;
  diagnostics: TradeDiagnostic[];
}

export interface PlayerIntelligenceProviders {
  usage: UsageProvider;
  schedule: ScheduleProvider;
}
/** No provider is registered anywhere in this repo today — every caller uses this default. */
export const DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS: PlayerIntelligenceProviders = {
  usage: NULL_USAGE_PROVIDER,
  schedule: NULL_SCHEDULE_PROVIDER,
};

/**
 * `hasAnyRecord` distinguishes two very different kinds of "no injury_status
 * string": (1) a resolvable player with no injury designation — the normal
 * representation of "not injured" in this repo's source data, correctly
 * HEALTHY — versus (2) an identity with NO canonical record and NO weekly
 * projection at all, where there is literally no evidence of anything. (2)
 * must never be reported as HEALTHY — that would assert a specific favorable
 * claim from zero data, exactly the "unavailable treated as neutral evidence"
 * failure mode Phase 3 is required to avoid. (Fixed by the Phase 3 audit, D1.)
 */
function classifyAvailability(injuryStatus: string | null, hasAnyRecord: boolean): AvailabilityStatus {
  if (!hasAnyRecord) return "UNKNOWN";
  if (!injuryStatus) return "HEALTHY";
  const s = injuryStatus.toLowerCase();
  if (s.includes("ir") || s.includes("injured reserve")) return "IR";
  if (s.includes("pup")) return "PUP";
  if (s.includes("suspend")) return "SUSPENDED";
  if (s.includes("out")) return "OUT";
  if (s.includes("doubtful")) return "DOUBTFUL";
  if (s.includes("questionable")) return "QUESTIONABLE";
  if (s.includes("active") || s.includes("healthy")) return "HEALTHY";
  return "UNKNOWN";
}

type KnownVolatility = "LOW" | "MEDIUM" | "HIGH";

function classifyVolatility(cv: number | null, disagreementPct: number | null): VolatilityLevel {
  const cvLevel: KnownVolatility | null = cv == null ? null : cv < 0.35 ? "LOW" : cv < 0.6 ? "MEDIUM" : "HIGH";
  const disagreeLevel: KnownVolatility | null =
    disagreementPct == null ? null : Math.abs(disagreementPct) < 0.15 ? "LOW" : Math.abs(disagreementPct) < 0.35 ? "MEDIUM" : "HIGH";
  if (cvLevel == null && disagreeLevel == null) return "UNKNOWN";
  const rank: Record<KnownVolatility, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  // take the WORSE (higher) of the two available signals — never understate volatility
  const candidates = [cvLevel, disagreeLevel].filter((x): x is KnownVolatility => x != null);
  return candidates.reduce((a, b) => (rank[b] > rank[a] ? b : a));
}

const usageSampleSize = (s: PlayerUsageSnapshot): number | null => s.routes ?? s.snaps ?? s.carries ?? null;
const usageShare = (s: PlayerUsageSnapshot): number | null =>
  s.route_participation ?? s.snap_share ?? s.target_share ?? s.rush_share ?? null;

export function buildPlayerIntelligence(
  playerId: string,
  ctx: TradeAnalysisContext,
  providers: PlayerIntelligenceProviders = DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS,
): PlayerIntelligence {
  const meta: CanonicalPlayer | undefined = ctx.players_by_id.get(playerId);
  const wp: WeeklyProjection | undefined = ctx.projections.by_player.get(playerId);
  const diagnostics: TradeDiagnostic[] = [];

  const hasAnyRecord = meta != null || wp != null;
  const injuryStatus = meta?.injury_status ?? wp?.injury_status ?? null;
  const availability: AvailabilityIntelligence = {
    status: classifyAvailability(injuryStatus, hasAnyRecord),
    expected_availability: wp?.expected_availability ?? null,
    raw_injury_status: injuryStatus,
    meta: { source: "canonical_player.injury_status + current-week projection", updated_at: null, freshness: wp ? "CURRENT" : "UNAVAILABLE" },
  };
  if (!hasAnyRecord) {
    diagnostics.push({ code: "PLAYER_INTELLIGENCE_UNAVAILABLE", message: `Player ${playerId} has no canonical record and no weekly projection in this context — availability is UNKNOWN, never asserted HEALTHY from zero evidence.`, severity: "info" });
  } else if (availability.status === "UNKNOWN") {
    diagnostics.push({ code: "INJURY_STATUS_UNCERTAIN", message: `Player ${playerId} has an unrecognized injury-status string ("${injuryStatus}") — treated as UNKNOWN, not HEALTHY.`, severity: "info" });
  }

  const projectedPts = wp?.projected_points ?? null;
  const stdDev = wp?.std_dev ?? null;
  const cv = projectedPts != null && projectedPts > 0 && stdDev != null ? Math.round((stdDev / projectedPts) * 1000) / 1000 : null;
  const rosSig = wp?.ros ?? null;
  const volatility: VolatilityIntelligence = {
    level: classifyVolatility(cv, rosSig?.disagreement_pct ?? null),
    weekly_coefficient_of_variation: cv,
    ros_disagreement_pct: rosSig?.disagreement_pct ?? null,
    ros_confidence: rosSig?.confidence ?? null,
    meta: { source: "weekly projection std_dev + RI/external ROS disagreement", updated_at: null, freshness: wp ? "CURRENT" : "UNAVAILABLE" },
  };
  if (volatility.level === "UNKNOWN") {
    diagnostics.push({ code: "PLAYER_INTELLIGENCE_UNAVAILABLE", message: `No volatility signal for player ${playerId} — no weekly std_dev or ROS disagreement available.`, severity: "info" });
  }

  // ---- usage (Phase 3.5B — pluggable; NULL_USAGE_PROVIDER everywhere today) ----
  const usageSnap = providers.usage.getCurrentUsage(playerId);
  let usage: UsageSignal;
  if (!usageSnap) {
    usage = { status: "UNAVAILABLE", reason: `No usage data for player ${playerId}: ${providers.usage.source_name}.` };
    diagnostics.push({ code: "USAGE_DATA_STALE", message: `Player ${playerId}: ${providers.usage.source_name}`, severity: "info" });
  } else {
    const sample = usageSampleSize(usageSnap);
    const smallSample = sample == null || sample < MIN_USAGE_SAMPLE_SIZE;
    usage = { status: "AVAILABLE", snapshot: usageSnap, small_sample: smallSample };
    if (smallSample) {
      diagnostics.push({ code: "USAGE_SAMPLE_TOO_SMALL", message: `Player ${playerId}: usage sample (${sample ?? "unknown"}) is below the ${MIN_USAGE_SAMPLE_SIZE}-snap/route/carry minimum — not confidently informative on its own.`, severity: "info" });
    }
    if (usageSnap.freshness === "STALE") {
      diagnostics.push({ code: "USAGE_DATA_STALE", message: `Player ${playerId}: usage snapshot from ${providers.usage.source_name} is STALE (week ${usageSnap.week}).`, severity: "info" });
    }
  }

  // ---- role / trend (derived from the same usage series — Phase 3.5B) ----
  const series = providers.usage.getRecentUsageSeries(playerId, 6);
  let role: RoleSignal;
  let trend: TrendSignal;
  if (series.length === 0) {
    role = { status: "UNAVAILABLE", stability: "UNCERTAIN", reason: "No multi-week usage history exists to classify role stability." };
    trend = { status: "UNAVAILABLE", reason: "No weekly usage time series exists to compute a trend." };
    diagnostics.push({ code: "ROLE_TREND_UNCERTAIN", message: `Player ${playerId}: no multi-week usage history exists to classify role stability or detect a trend — role is UNCERTAIN, never asserted.`, severity: "info" });
  } else {
    const shares = series.map((s) => ({ share: usageShare(s), sample_size: usageSampleSize(s) }));
    const usageTrend = classifyUsageTrend(shares);
    const stability: RoleStability = usageTrend === "INSUFFICIENT_DATA" ? "UNCERTAIN" : usageTrend;
    role = { status: "AVAILABLE", stability, trend: usageTrend, weeks_observed: series.length };
    trend = { status: "AVAILABLE", trend: usageTrend };
    if (usageTrend === "INSUFFICIENT_DATA") {
      diagnostics.push({ code: "ROLE_TREND_UNCERTAIN", message: `Player ${playerId}: only ${series.length} usable usage week(s) observed — too few to call a directional trend; role reported UNCERTAIN, not asserted.`, severity: "info" });
    }
  }

  // ---- schedule (Phase 3.5C — pluggable; NULL_SCHEDULE_PROVIDER everywhere today) ----
  const matchup = providers.schedule.getWeeklyMatchup(playerId, ctx.week);
  let schedule: ScheduleSignal;
  if (!matchup) {
    schedule = { status: "UNAVAILABLE", reason: `No schedule-strength data for player ${playerId}: ${providers.schedule.source_name}.` };
    diagnostics.push({ code: "SCHEDULE_STRENGTH_UNAVAILABLE", message: `Player ${playerId}: ${providers.schedule.source_name}`, severity: "info" });
  } else {
    schedule = { status: "AVAILABLE", context: matchup };
    if (matchup.freshness !== "CURRENT") {
      diagnostics.push({ code: "SCHEDULE_STRENGTH_UNAVAILABLE", message: `Player ${playerId}: schedule-strength data from ${providers.schedule.source_name} is not CURRENT (freshness=${matchup.freshness}).`, severity: "info" });
    }
  }

  return {
    canonical_player_id: playerId,
    availability,
    volatility,
    usage,
    role,
    trend,
    schedule,
    diagnostics,
  };
}
