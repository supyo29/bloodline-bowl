/**
 * Trade Engine — Phase 3B: player intelligence layer.
 *
 * A structured, source-backed context layer for individual players. The
 * project has NO live in-season usage-stats feed (no rolling snap share /
 * target share / route participation / red-zone-touch tracker — the only
 * usage-component data in the repo lives in `lib/projections/*`, the
 * PRESEASON Roster Intel draft model, which Phase 1/2 already documented as
 * "not a defensible opponent-specific WEEKLY projection" and consume only
 * ORDINALLY). Per the Phase 3 mandate ("do not invent unavailable
 * statistics"), every usage/role/trend/schedule signal below is honestly
 * `UNAVAILABLE` with a diagnostic — never a fabricated number.
 *
 * What IS genuinely source-backed and is populated for real:
 *   - availability: `CanonicalPlayer.injury_status` + the current-week
 *     `WeeklyProjection.expected_availability` (Phase 1's own inputs).
 *   - volatility: the current-week projection's `std_dev` (coefficient of
 *     variation) plus the existing RI-vs-external ROS disagreement signal
 *     (`RosSignal.disagreement_pct` / `.confidence`) — both already computed
 *     upstream, reused here rather than re-derived.
 *
 * This module NEVER decides player value. It only describes what is known
 * about a player so the confidence layer (Phase 3C) and any future calibrated
 * adjustment (Phase 3D, currently weight 0 — see `phase3.ts`) can consume it.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection } from "@/lib/weekly/schema";
import type { TradeAnalysisContext } from "./context";
import type { TradeDiagnostic } from "./schema";

export type DataFreshness = "CURRENT" | "STALE" | "UNAVAILABLE";
export type AvailabilityStatus =
  | "HEALTHY"
  | "QUESTIONABLE"
  | "DOUBTFUL"
  | "OUT"
  | "IR"
  | "PUP"
  | "SUSPENDED"
  | "RETURNING"
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

/** Always UNAVAILABLE in this repo today — no live usage-share feed exists. Present so the schema is stable when one is added. */
export interface UnavailableSignal {
  status: "UNAVAILABLE";
  reason: string;
}

export interface PlayerIntelligence {
  canonical_player_id: string;
  availability: AvailabilityIntelligence;
  volatility: VolatilityIntelligence;
  /** Phase 3B usage/opportunity signals (snap share, target share, carry share, etc.) */
  usage: UnavailableSignal;
  /** Phase 3B role-stability classification */
  role: UnavailableSignal & { stability: RoleStability };
  /** Phase 3B trend detection (usage_trend, target_share_trend, ...) */
  trend: UnavailableSignal;
  /** Phase 3B schedule context (remaining_schedule_quality, playoff_schedule_quality) */
  schedule: UnavailableSignal;
  diagnostics: TradeDiagnostic[];
}

const NO_USAGE_FEED =
  "No live in-season usage-stats feed exists in this repository (snap share / target share / route participation / red-zone touches). The preseason Roster Intel draft model is not a defensible weekly usage tracker and is not substituted here.";

function classifyAvailability(injuryStatus: string | null): AvailabilityStatus {
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

export function buildPlayerIntelligence(playerId: string, ctx: TradeAnalysisContext): PlayerIntelligence {
  const meta: CanonicalPlayer | undefined = ctx.players_by_id.get(playerId);
  const wp: WeeklyProjection | undefined = ctx.projections.by_player.get(playerId);
  const diagnostics: TradeDiagnostic[] = [];

  const injuryStatus = meta?.injury_status ?? wp?.injury_status ?? null;
  const availability: AvailabilityIntelligence = {
    status: classifyAvailability(injuryStatus),
    expected_availability: wp?.expected_availability ?? null,
    raw_injury_status: injuryStatus,
    meta: { source: "canonical_player.injury_status + current-week projection", updated_at: null, freshness: wp ? "CURRENT" : "UNAVAILABLE" },
  };
  if (availability.status === "UNKNOWN") {
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

  diagnostics.push({ code: "USAGE_DATA_STALE", message: `Player ${playerId}: ${NO_USAGE_FEED}`, severity: "info" });
  diagnostics.push({ code: "ROLE_TREND_UNCERTAIN", message: `Player ${playerId}: no multi-week usage history exists to classify role stability or detect a trend — role is UNCERTAIN, never asserted.`, severity: "info" });
  diagnostics.push({ code: "SCHEDULE_STRENGTH_UNAVAILABLE", message: `Player ${playerId}: no opponent-adjusted schedule-strength source exists in this repository.`, severity: "info" });

  return {
    canonical_player_id: playerId,
    availability,
    volatility,
    usage: { status: "UNAVAILABLE", reason: NO_USAGE_FEED },
    role: { status: "UNAVAILABLE", stability: "UNCERTAIN", reason: "No multi-week usage history exists to classify role stability." },
    trend: { status: "UNAVAILABLE", reason: "No weekly usage time series exists to compute a trend." },
    schedule: { status: "UNAVAILABLE", reason: "No opponent-adjusted efficiency or position-specific schedule-strength source exists in this repository." },
    diagnostics,
  };
}
