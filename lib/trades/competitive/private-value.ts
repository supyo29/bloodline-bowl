/**
 * Competitive Trade Intelligence — normalized PRIVATE value (Checkpoint B).
 *
 * The private side is model-agnostic by construction: it reads only the
 * normalized weekly-projection surface (`projected_points`, `ros`) that the
 * trade context already produces, never a specific model's internals. A future
 * projection model plugs in with no change here.
 *
 * Basis: current-week value-over-replacement (`weeklyVOR`) against the SAME
 * league replacement frontier the market side uses — so the two normalized
 * scales share a zero point. `ros.ri_position_rank` / `ros.ri_vor` /
 * `ros.ri_confidence` are carried for explanation and confidence only (RI's
 * absolute season level has a documented calibration caveat — see
 * `lib/weekly/schema.ts` `RosSignal`).
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjectionBatch, WeeklyReplacement } from "@/lib/weekly/schema";
import { weeklyVOR } from "@/lib/weekly/replacement";
import type { ValueConfidence } from "./schema";

export interface PlayerPrivateValue {
  canonical_player_id: string;
  position: string;
  /** weekly VOR (league points over replacement) — the normalization basis */
  raw: number | null;
  /**
   * `ri_ros_weekly_vor` — RI's own season projection ÷ 17 as a weekly rate, then
   *   VOR against the league frontier. PREFERRED: it is rest-of-season-oriented
   *   (matching the market side, which is Sleeper ROS ÷ remaining weeks) and
   *   more dispersed than a single noisy current week, so within-position
   *   z-scores are stable. RI's absolute season LEVEL has a calibration caveat
   *   (`lib/weekly/schema.ts` RosSignal) but within-position z-scoring removes
   *   both location and scale — only the ordinal spacing needs to be right,
   *   which is RI's asserted strength.
   * `weekly_vor` — fallback: current-week projected points → VOR, when no RI
   *   season projection exists for the player.
   */
  basis: "ri_ros_weekly_vor" | "weekly_vor" | "unavailable";
  projected_points: number | null;
  ri_position_rank: number | null;
  ri_season_vor: number | null;
  confidence: ValueConfidence;
  model_version: string | null;
  as_of: string | null;
}

const RI_CONF_MAP: Record<string, ValueConfidence> = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  VERY_LOW: "VERY_LOW",
};

export function buildPrivateValues(input: {
  projections: WeeklyProjectionBatch;
  replacement: WeeklyReplacement;
  players_by_id: Map<string, CanonicalPlayer>;
  universe: string[];
  as_of_iso: string;
}): Map<string, PlayerPrivateValue> {
  const { projections, replacement, players_by_id, universe, as_of_iso } = input;
  const out = new Map<string, PlayerPrivateValue>();

  for (const cid of universe) {
    const player = players_by_id.get(cid);
    const wp = projections.by_player.get(cid);
    const position = player?.position ?? wp?.position ?? "UNKNOWN";
    const pts = wp?.projected_points ?? null;

    // preferred basis: RI season projection ÷ 17 (ROS-oriented weekly rate)
    const riSeason = wp?.ros?.ri_season_points ?? null;
    let basis: PlayerPrivateValue["basis"] = "unavailable";
    let raw: number | null = null;
    if (riSeason != null) {
      const v = weeklyVOR(cid, position, round2(riSeason / 17), replacement);
      if (v.vor != null) {
        raw = v.vor;
        basis = "ri_ros_weekly_vor";
      }
    }
    if (raw == null && pts != null) {
      const v = weeklyVOR(cid, position, pts, replacement);
      if (v.vor != null) {
        raw = v.vor;
        basis = "weekly_vor";
      }
    }

    // confidence: prefer the ROS signal's RI confidence; else infer from
    // projection availability. Never optimistic on missing data.
    let confidence: ValueConfidence = "VERY_LOW";
    const riConf = wp?.ros?.ri_confidence ?? null;
    if (riConf && RI_CONF_MAP[riConf]) {
      confidence = RI_CONF_MAP[riConf];
    } else if (pts != null && projections.status === "READY") {
      confidence = "MEDIUM";
    } else if (pts != null) {
      confidence = "LOW";
    }

    out.set(cid, {
      canonical_player_id: cid,
      position,
      raw,
      basis,
      projected_points: pts,
      ri_position_rank: wp?.ros?.ri_position_rank ?? null,
      ri_season_vor: wp?.ros?.ri_vor ?? null,
      confidence,
      model_version: projections.model_version ?? null,
      as_of: as_of_iso,
    });
  }

  return out;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
