/**
 * Phase 4 — orthogonal weekly readiness composition.
 *
 * Pure by design. This is the one place that turns already-established facts
 * into the machine-readable readiness contract consumed by waiver/intelligence
 * APIs. It never fetches data and never re-derives market or capability truth.
 */

import type { CapabilityAssessment } from "@/lib/canonical/capabilities";
import type { WeeklyProjectionBatch, WeeklyReadinessContract } from "./schema";

export interface ComposeWeeklyReadinessInput {
  live_provider_status: "READY" | "PARTIAL";
  ownership: CapabilityAssessment;
  market: WeeklyReadinessContract["market"];
  projection_status: WeeklyProjectionBatch["status"];
  roster_players_projected: number;
  roster_players_total: number;
  missing_roster_players: number;
  want_rest_of_season: boolean;
  external_ros_players_available: number;
  season_segment_degraded: boolean;
  ri_status: "READY" | "UNAVAILABLE" | "NOT_REQUESTED";
}

export function composeWeeklyReadiness(
  input: ComposeWeeklyReadinessInput,
): WeeklyReadinessContract {
  const ownershipReadiness: WeeklyReadinessContract["ownership"] = {
    status:
      input.ownership.status === "HEALTHY"
        ? "READY"
        : input.ownership.status === "DEGRADED"
          ? "DEGRADED"
          : "UNAVAILABLE",
    usable: input.ownership.status !== "UNAVAILABLE",
    reasons: [...input.ownership.reasons],
    missing_inputs: [...input.ownership.missing_inputs],
  };

  const weeklyProjectionReadiness: WeeklyReadinessContract["weekly_projections"] = {
    status:
      input.projection_status === "PROJECTIONS_UNAVAILABLE"
        ? "UNAVAILABLE"
        : input.projection_status === "PROJECTIONS_PARTIAL" || input.missing_roster_players > 0
          ? "PARTIAL"
          : "READY",
    usable:
      input.projection_status !== "PROJECTIONS_UNAVAILABLE" &&
      (input.roster_players_total === 0 || input.roster_players_projected > 0),
    roster_players_projected: input.roster_players_projected,
    roster_players_total: input.roster_players_total,
    missing_roster_players: input.missing_roster_players,
  };

  const rosReadiness: WeeklyReadinessContract["rest_of_season"] = {
    status: !input.want_rest_of_season
      ? "NOT_REQUESTED"
      : input.external_ros_players_available === 0
        ? "UNAVAILABLE"
        : input.external_ros_players_available < input.roster_players_total || input.season_segment_degraded
          ? "PARTIAL"
          : "READY",
    usable: input.want_rest_of_season && input.external_ros_players_available > 0,
    external_players_available: input.external_ros_players_available,
    roster_players_total: input.roster_players_total,
    ri_status: input.ri_status,
  };

  const blockedBy: string[] = [];
  const limitations: string[] = [];

  if (!input.market.actionable) blockedBy.push("market_not_actionable");
  if (!ownershipReadiness.usable) blockedBy.push("ownership_unavailable");
  if (!weeklyProjectionReadiness.usable) blockedBy.push("weekly_projections_unavailable");

  if (input.market.status === "PARTIAL") limitations.push("market_partial");
  if (ownershipReadiness.status === "DEGRADED") limitations.push("ownership_degraded");
  if (weeklyProjectionReadiness.status === "PARTIAL") limitations.push("weekly_projections_partial");
  if (rosReadiness.status === "PARTIAL") limitations.push("rest_of_season_partial");
  if (rosReadiness.status === "UNAVAILABLE" && input.want_rest_of_season) limitations.push("rest_of_season_unavailable");
  if (rosReadiness.ri_status === "UNAVAILABLE") limitations.push("ri_season_signal_unavailable");

  return {
    live_provider: {
      status: input.live_provider_status,
      usable: true,
    },
    ownership: ownershipReadiness,
    market: input.market,
    weekly_projections: weeklyProjectionReadiness,
    rest_of_season: rosReadiness,
    waiver_recommendations: {
      status:
        blockedBy.length > 0
          ? "NOT_READY"
          : limitations.length > 0
            ? "READY_WITH_LIMITATIONS"
            : "READY",
      actionable: blockedBy.length === 0,
      blocked_by: blockedBy,
      limitations,
    },
  };
}
