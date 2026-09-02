/**
 * Assemble the rest-of-season (`RosSignal`) for every projected player.
 *
 *  - ABSOLUTE points (`ros.points`) come from the EXTERNAL (Sleeper/RotoWire)
 *    season projection, prorated by remaining weeks. This is the only source
 *    used for absolute weekly-equivalent arithmetic.
 *  - RI's independent season model contributes ORDINAL signals (position rank,
 *    VOR, tier) and a DISAGREEMENT vs the external season projection. RI points
 *    are exposed for inspection but never numerically blended with Sleeper's.
 *  - `ros.confidence` is downgraded when RI and the external model disagree
 *    materially — that is the useful product of having two independent models.
 *
 * Pure: no network. Mutates `batch.by_player[*].ros`.
 */

import type { RiSeasonSignalResult } from "./projections-ri";
import type { Confidence, RosSignal, WeeklyProjectionBatch } from "./schema";

const REGULAR_SEASON_WEEKS = 17;
const AGREE_PCT = 0.12;
const MATERIAL_DISAGREE_PCT = 0.3;

export interface RosAssemblyResult {
  ri_status: "READY" | "UNAVAILABLE";
  ri_model_version: string | null;
  external_source: string;
  players_with_ri: number;
  players_with_disagreement: number;
  warnings: string[];
}

export function assembleRosSignals(
  batch: WeeklyProjectionBatch,
  ri: RiSeasonSignalResult,
  week: number,
): RosAssemblyResult {
  const weeksLeftFrac = Math.max(0, (REGULAR_SEASON_WEEKS - (week - 1)) / REGULAR_SEASON_WEEKS);
  let withRi = 0;
  let withDisagreement = 0;
  const warnings: string[] = [];
  if (ri.warning) warnings.push(ri.warning);

  for (const wp of batch.by_player.values()) {
    const meta = batch.resolved_players.get(wp.canonical_player_id);
    const sleeperId = meta?.identifiers?.sleeper_id ?? null;
    const riEntry = sleeperId ? ri.by_sleeper_id.get(sleeperId) ?? null : null;

    // External absolute ROS: prefer RI's benchmark field (already league-scored),
    // else the provider's own prorated figure.
    const externalSeason = riEntry?.external_season_points ?? null;
    const externalRos =
      externalSeason != null
        ? Math.round(externalSeason * weeksLeftFrac * 100) / 100
        : wp.rest_of_season_points;

    let disagreement_pct: number | null = null;
    let disagreement_direction: RosSignal["disagreement_direction"] = "NONE";
    if (riEntry?.ri_season_points != null && externalSeason != null && externalSeason !== 0) {
      disagreement_pct = Math.round(((riEntry.ri_season_points - externalSeason) / externalSeason) * 1000) / 1000;
      const abs = Math.abs(disagreement_pct);
      disagreement_direction =
        abs <= AGREE_PCT ? "AGREE" : disagreement_pct > 0 ? "RI_ABOVE" : "RI_BELOW";
      if (abs > AGREE_PCT) withDisagreement += 1;
    } else if (riEntry?.ri_season_points != null || externalSeason != null) {
      disagreement_direction = "ONE_SOURCE";
    }

    let confidence: Confidence = "MEDIUM";
    if (disagreement_direction === "AGREE") confidence = "HIGH";
    else if (
      disagreement_direction === "RI_ABOVE" ||
      disagreement_direction === "RI_BELOW"
    ) {
      confidence = Math.abs(disagreement_pct ?? 0) > MATERIAL_DISAGREE_PCT ? "LOW" : "MEDIUM";
    } else if (disagreement_direction === "ONE_SOURCE") confidence = "MEDIUM";
    else if (externalRos == null) confidence = "LOW";

    if (riEntry) withRi += 1;

    const signal: RosSignal = {
      points: externalRos,
      source: "sleeper_season_rotowire_prorated",
      external_season_points: externalSeason ?? null,
      ri_season_points: riEntry?.ri_season_points ?? null,
      ri_position_rank: riEntry?.ri_position_rank ?? null,
      ri_vor: riEntry?.ri_vor ?? null,
      ri_tier: riEntry?.ri_tier ?? null,
      ri_confidence: riEntry?.ri_confidence ?? null,
      disagreement_pct,
      disagreement_direction,
      confidence,
      warnings:
        disagreement_direction === "RI_ABOVE" || disagreement_direction === "RI_BELOW"
          ? [`RI season model ${disagreement_direction === "RI_ABOVE" ? "above" : "below"} external by ${Math.round(Math.abs(disagreement_pct ?? 0) * 100)}%${riEntry?.primary_driver ? ` (driver: ${riEntry.primary_driver})` : ""}`]
          : [],
    };

    wp.ros = signal;
    wp.rest_of_season_points = signal.points;
  }

  if (ri.status === "READY" && withRi === 0) {
    warnings.push("Roster Intel season model loaded but no players crosswalked to it (sleeper_id gap).");
  }

  return {
    ri_status: ri.status,
    ri_model_version: ri.model_version,
    external_source: "sleeper_season_rotowire",
    players_with_ri: withRi,
    players_with_disagreement: withDisagreement,
    warnings,
  };
}
