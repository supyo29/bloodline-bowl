/**
 * The decision-value VIEW: the single sanctioned way for a decision engine (the lineup optimizer, the matchup simulation) to read
 * per-player current-week values.
 *
 * - With canonical forecasts it returns `WeeklyProjection`-shaped rows whose `projected_points` is the canonical injury-aware
 *   `expected_points`, `expected_availability` is the model's P(active), and `std_dev` is the participation-mixture std.
 *   Nothing is invented here: every number is read off the canonical forecast.
 * - Without forecasts (callers that have not migrated: trades, schedule-planning, ROS) it returns the legacy rows UNCHANGED and
 *   says so. That fallback is the single audited legacy path and is the thing later phases retire.
 *
 * Rows are derived views for an engine's internal use; they are never persisted and never fed back into `ctx.projections`.
 */

import type { WeeklyProjection, WeeklyProjectionBatch } from "../schema";
import type { CanonicalWeeklyForecastBatch } from "./schema";

export interface DecisionRows {
  rows: ReadonlyMap<string, WeeklyProjection>;
  basis: "CANONICAL_FORECAST_EXPECTED_POINTS" | "LEGACY_SOURCE_PROJECTION_FALLBACK";
}

export function decisionProjectionRows(
  projections: WeeklyProjectionBatch,
  forecasts?: CanonicalWeeklyForecastBatch | null,
): DecisionRows {
  if (!forecasts) return { rows: projections.by_player, basis: "LEGACY_SOURCE_PROJECTION_FALLBACK" };
  const out = new Map<string, WeeklyProjection>();
  for (const [id, row] of projections.by_player) {
    const f = forecasts.by_player.get(id);
    if (!f) {
      out.set(id, row); // player outside the forecast universe: keep the legacy row rather than guess
      continue;
    }
    // A bye keeps the legacy bye row (status "bye", 0): lineup/matchup treat it as VERIFIED_ZERO.
    if (f.game_status.is_bye) {
      out.set(id, row);
      continue;
    }
    const ep = f.projection.expected_points;
    const sd = f.uncertainty.variance == null ? row.std_dev : Math.sqrt(f.uncertainty.variance);
    out.set(id, {
      ...row,
      projected_points: ep,
      std_dev: sd,
      // A player who cannot be a startable asset this week reads as unavailable in the injury-risk lists.
      expected_availability: f.availability.probability_active ?? row.expected_availability,
      // known-unavailable is a known zero; every other state keeps its legacy status (unknown stays unknown)
      warnings: f.value_state === "KNOWN_UNAVAILABLE" ? [...row.warnings, "known_unavailable_expected_zero"] : row.warnings,
    });
  }
  // A KNOWN-unavailable player the source never projected (feeds commonly omit them) is a known zero, not an unknown: surface it so
  // the optimizer does not leave a provisional hole for a player who is certainly not playing.
  for (const [id, f] of forecasts.by_player) {
    if (out.has(id) || projections.by_player.has(id) || f.value_state !== "KNOWN_UNAVAILABLE") continue;
    out.set(id, {
      canonical_player_id: id,
      week: f.week,
      season: f.season,
      position: f.position ?? "",
      nfl_team: f.team,
      opponent: f.opponent,
      is_home: null,
      projected_points: 0,
      floor_points: 0,
      ceiling_points: 0,
      std_dev: 0,
      projection_status: "out",
      expected_availability: 0,
      is_bye: false,
      injury_status: f.availability.injury_status,
      rest_of_season_points: null,
      ros: null,
      source: f.provenance.projection_provider ?? "canonical_forecast",
      model_version: f.model_version,
      uncertainty_source: "none",
      warnings: ["known_unavailable_expected_zero", "no_source_projection_row"],
    });
  }
  return { rows: out, basis: "CANONICAL_FORECAST_EXPECTED_POINTS" };
}
