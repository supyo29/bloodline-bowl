/**
 * Phase 9 Step 7 / Phase 6 compatibility (gate 11) — actual fantasy points for a completed game, using the SAME
 * canonical engine and the SAME K/DST boundary production uses (`lib/weekly/projections/sleeper-weekly.ts`).
 * No scoring math is re-implemented here: `materializeScoringEvents` (Phase 6's single owner of derived events —
 * return-yard fix included) and `scoreWeeklyLine` (offense) are reused verbatim; K/DST stays on Sleeper's own
 * `pts_std` provider-standard points, exactly as production does, carrying the identical warning string so the
 * limitation is never silently dropped.
 */
import { materializeScoringEvents } from "@/lib/scoring/derived-events";
import { scoreWeeklyLine, NON_SCORING_KEY } from "@/lib/weekly/scoring";
import { getStatsProvider } from "@/lib/stats/provider";
import { getWeeklyStats } from "@/lib/sleeper/client";
import type { PlayerStatLine } from "@/lib/stats/types";

export type ActualPointsBasis = "LEAGUE_RESCORED" | "PROVIDER_STANDARD_POINTS_KDST" | "REAL_ZERO_NO_STATS" | "UNAVAILABLE";
export interface ActualPoints { basis: ActualPointsBasis; points: number | null; warnings: string[] }

/**
 * Sleeper's own `pts_std` for K/DST (Phase 6 documented boundary: weekly K/D-ST stays PROVIDER_STANDARD_POINTS,
 * never league-rescored). `rawStats` is the UNSTRIPPED provider blob (the `pts_*` provider-computed keys must
 * still be present) — callers must pass `getWeeklyStats()` output, not `getStatsProvider()` output, for K/DEF.
 */
export function actualPointsForKdst(rawStats: Record<string, number> | undefined): ActualPoints {
  if (!rawStats) return { basis: "UNAVAILABLE", points: null, warnings: ["no stat row for this player-week"] };
  const keys = Object.keys(rawStats);
  if (!keys.length) return { basis: "UNAVAILABLE", points: null, warnings: ["empty stat row"] };
  const std = Number(rawStats.pts_std);
  if (!Number.isFinite(std)) return { basis: "UNAVAILABLE", points: null, warnings: ["stat row present but pts_std missing/non-numeric"] };
  return { basis: "PROVIDER_STANDARD_POINTS_KDST", points: Math.round(std * 100) / 100, warnings: ["k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)"] };
}

/**
 * Offense (QB/RB/WR/TE): league-rescored via the canonical engine. `stats` must be the PRE-STRIPPED component
 * line (from `getStatsProvider().getWeeklyStats()`, which already excludes the provider's own `pts_*` totals — see
 * `lib/stats/provider.ts`). A row with no component stats (nothing but metadata) is REAL_ZERO_NO_STATS only if the
 * provider published the row at all; if the player has no row whatsoever, that is UNAVAILABLE, never a silent zero.
 */
export function actualPointsForOffense(position: string, stats: Record<string, number> | undefined, rawScoring: Record<string, number>): ActualPoints {
  if (!stats) return { basis: "UNAVAILABLE", points: null, warnings: ["no stat row for this player-week (DNP, inactive, or provider gap — not distinguishable from here)"] };
  const materialized = materializeScoringEvents(stats, { position }).stats;
  const hasComponent = Object.keys(materialized).some((k) => !NON_SCORING_KEY.test(k) && !/^pts_/.test(k));
  if (!hasComponent) return { basis: "REAL_ZERO_NO_STATS", points: 0, warnings: ["provider published a row with no component stats: treated as a real zero, not missing data"] };
  const scored = scoreWeeklyLine(materialized, rawScoring);
  return { basis: "LEAGUE_RESCORED", points: scored.points, warnings: [] };
}

/** Dispatches by canonical position. `rawStats` (unstripped, for K/DST pts_std) and `cleanStats` (component-only, for offense) are both required. */
export function actualPointsFor(position: string, cleanStats: Record<string, number> | undefined, rawStats: Record<string, number> | undefined, rawScoring: Record<string, number>): ActualPoints {
  return position === "K" || position === "DEF" ? actualPointsForKdst(rawStats) : actualPointsForOffense(position, cleanStats, rawScoring);
}

/** Extracts the Sleeper player id from a `player:sleeper:<id>` canonical id. Any other identity scheme returns null (never guessed). */
export function sleeperIdFromCanonical(canonicalPlayerId: string): string | null {
  const m = /^player:sleeper:(.+)$/.exec(canonicalPlayerId);
  return m ? m[1]! : null;
}

export interface WeekActuals { clean: ReadonlyMap<string, Record<string, number>>; raw: ReadonlyMap<string, Record<string, number>> }
/** One fetch per (season, week), shared across every player/decision an audit evaluates — never per-player. */
export async function loadWeekActuals(season: number, week: number): Promise<WeekActuals> {
  const [cleanRows, rawRows] = await Promise.all([
    getStatsProvider().getWeeklyStats(String(season), week) as Promise<PlayerStatLine[]>,
    getWeeklyStats(String(season), week),
  ]);
  return {
    clean: new Map(cleanRows.map((r) => [r.player_id, r.stats])),
    raw: new Map(Object.entries(rawRows).filter(([id]) => !id.startsWith("TEAM_")).map(([id, s]) => [id.toUpperCase(), s as unknown as Record<string, number>])),
  };
}
