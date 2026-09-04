/**
 * Trade Engine — Phase 2B: rest-of-season contextual valuation.
 *
 * Phase 1 answers "what happens to each lineup THIS week". Phase 2B answers
 * "what are those roster changes worth over the remaining fantasy weeks",
 * WITHOUT replacing any Phase 1 metric.
 *
 * Method — marginal USABLE contribution, not summed season totals:
 *   - per remaining fantasy week, each rostered player contributes its
 *     rest-of-season weekly mean (external prorated ROS ÷ its remaining games),
 *     or a schedule-verified 0 on a bye week;
 *   - `buildOptimalLineup` (the SAME Phase 1 optimizer) is run for that week, so
 *     roster displacement, bye holes and positional limits all apply;
 *   - the weeks are summed and split into regular-season vs playoff windows.
 *
 * A player projected for 160 ROS points is NOT worth +160 to a roster if most of
 * those points would sit on the bench — the model only ever credits what the
 * optimal weekly lineup would actually start.
 *
 * Players with no ROS signal are EXCLUDED from the ROS lineup (never treated as
 * 0) and listed in `ros_uncovered_players`; the result is flagged
 * `ROS_PARTIAL_PLAYER_COVERAGE`. Phase 1 output is never affected.
 *
 * Pure and deterministic.
 */

import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "@/lib/weekly/schema";
import { buildOptimalLineup } from "@/lib/weekly/lineup";
import type { TradeAnalysisContext, RosScheduleContext } from "./context";
import type { TradeDiagnostic } from "./schema";

/** Rounds to 2dp and normalizes -0 -> 0 (a leave-one-out delta of exactly zero
 *  should never display or compare as the surprising `-0`). */
const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

export interface RosPlayerSignal {
  canonical_player_id: string;
  /** external prorated rest-of-season points (the only absolute source used) */
  ros_points: number | null;
  /** remaining fantasy weeks this player's NFL team actually plays (byes removed) */
  ros_games_remaining: number;
  /** ros_points / ros_games_remaining — the per-playing-week mean */
  ros_weekly_mean: number | null;
  /** qualitative confidence carried through from the weekly ROS signal */
  ros_confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  covered: boolean;
}

export interface RosRosterValue {
  /** Σ optimal weekly lineup total across ALL remaining weeks */
  usable_ros_points: number;
  regular_season_usable: number;
  playoff_window_usable: number;
  /** Σ standalone ros_points of every rostered player (bench included) */
  standalone_ros_points: number;
  /** standalone − usable: ROS production that never reaches a starting slot */
  stranded_ros_points: number;
  /** (slot × week) starter slots the roster could not fill across the ROS range */
  bye_hole_slot_weeks: number;
  /** remaining weeks with at least one unfillable starter slot */
  bye_hole_weeks: number;
  /** per-week optimal totals, for inspection */
  weekly_totals: Array<{ week: number; total: number; empty_slots: number }>;
  /** rostered players with no ROS signal — excluded from the ROS lineup */
  uncovered_player_ids: string[];
}

export interface MarginalPlayerUtility {
  canonical_player_id: string;
  direction: "INCOMING" | "OUTGOING";
  standalone_weekly_projection: number | null;
  standalone_ros_projection: number | null;
  /** leave-one-out ROS lineup delta this player is responsible for on the relevant roster */
  marginal_ros_delta: number | null;
  /** leave-one-out CURRENT-week optimal-lineup delta (Phase 1 unit, for comparison) */
  marginal_starter_delta: number | null;
}

export interface RosParticipantResult {
  before: RosRosterValue;
  after: RosRosterValue;
  /** after.usable_ros_points − before.usable_ros_points */
  ros_usable_value_delta: number;
  regular_season_ros_delta: number;
  playoff_window_delta: number | null;
  /** before.bye_hole_slot_weeks − after.bye_hole_slot_weeks (positive = fewer holes = better) */
  bye_coverage_delta: number;
  /** standalone ROS points swing (incoming − outgoing) — the naive number, for contrast */
  standalone_ros_swing: number;
  marginal_player_utility: MarginalPlayerUtility[];
  /** ros_usable_value_delta − Σ(marginal_ros_delta) — non-additive interaction not cleanly attributable */
  interaction_residual: number;
  /** share of usable ROS carried by the roster's single best contributor, before vs after */
  usable_concentration_before: number;
  usable_concentration_after: number;
  /** after − before */
  consolidation_effect: number;
  roster_shape_delta: "STAR_CONCENTRATION" | "DEPTH_DISTRIBUTION" | "NEUTRAL";
  diagnostics: TradeDiagnostic[];
}

/* ------------------------------------------------------------------ signals */

export function rosSignalFor(
  playerId: string,
  players_by_id: Map<string, CanonicalPlayer>,
  projections: WeeklyProjectionBatch,
  ros: RosScheduleContext,
): RosPlayerSignal {
  const wp = projections.by_player.get(playerId) ?? null;
  const meta = players_by_id.get(playerId) ?? projections.resolved_players.get(playerId) ?? null;
  const team = (meta?.nfl_team ?? wp?.nfl_team ?? "").toUpperCase();
  const byeSet = team ? ros.bye_weeks_by_team.get(team) ?? null : null;
  const gamesRemaining = ros.weeks.reduce((n, w) => n + (byeSet?.has(w) ? 0 : 1), 0);

  const rosPoints = wp?.ros?.points ?? wp?.rest_of_season_points ?? null;
  const weeklyMean = rosPoints != null && gamesRemaining > 0 ? round2(rosPoints / gamesRemaining) : null;

  return {
    canonical_player_id: playerId,
    ros_points: rosPoints,
    ros_games_remaining: gamesRemaining,
    ros_weekly_mean: weeklyMean,
    ros_confidence: wp?.ros?.confidence ?? null,
    covered: weeklyMean != null,
  };
}

/* --------------------------------------------------------- per-week ROS batch */

function rosWeekProjection(
  playerId: string,
  position: string,
  mean: number,
  onBye: boolean,
  week: number,
  season: number,
): WeeklyProjection {
  return {
    canonical_player_id: playerId,
    week,
    season,
    position,
    nfl_team: null,
    opponent: null,
    is_home: null,
    projected_points: onBye ? 0 : mean,
    floor_points: null,
    ceiling_points: null,
    std_dev: null,
    projection_status: onBye ? "bye" : "projected",
    expected_availability: onBye ? 0 : 1,
    is_bye: onBye,
    injury_status: null,
    rest_of_season_points: null,
    ros: null,
    source: "trade_ros_model",
    model_version: "ri-trade-contextual-2026.2",
    uncertainty_source: "none",
    warnings: [],
  };
}

function rosWeekBatch(
  week: number,
  season: number,
  rosterPlayerIds: string[],
  signalById: Map<string, RosPlayerSignal>,
  players_by_id: Map<string, CanonicalPlayer>,
  ros: RosScheduleContext,
): WeeklyProjectionBatch {
  const by_player = new Map<string, WeeklyProjection>();
  const resolved_players = new Map<string, CanonicalPlayer>();
  for (const id of rosterPlayerIds) {
    const sig = signalById.get(id);
    const meta = players_by_id.get(id);
    if (!sig || !sig.covered || !meta) continue; // uncovered -> excluded (never a 0)
    const team = (meta.nfl_team ?? "").toUpperCase();
    // A player on a schedule-verified bye is NOT available that week — exclude
    // them so the optimizer starts a real backup if one exists and leaves the
    // slot genuinely empty (a bye HOLE) if not.
    if (team && ros.bye_weeks_by_team.get(team)?.has(week)) continue;
    by_player.set(id, rosWeekProjection(id, meta.position, sig.ros_weekly_mean!, false, week, season));
    resolved_players.set(id, meta);
  }
  return {
    league_slug: "trade-ros",
    season,
    week,
    status: "READY",
    by_player,
    resolved_players,
    source: "trade_ros_model",
    model_version: "ri-trade-contextual-2026.2",
    missing: [],
    teams_with_games: [],
    warnings: [],
  };
}

/* ------------------------------------------------------------- roster valuation */

export function rosRosterValue(
  roster: CanonicalRoster,
  ctx: TradeAnalysisContext,
  signalById: Map<string, RosPlayerSignal>,
): RosRosterValue {
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const activeIds = roster.all_players.filter((id) => !reserve.has(id));
  const playerMap = new Map<string, CanonicalPlayer>();
  for (const id of roster.all_players) {
    const m = ctx.players_by_id.get(id);
    if (m) playerMap.set(id, m);
  }

  const uncovered = activeIds.filter((id) => !(signalById.get(id)?.covered ?? false));

  let usable = 0;
  let regUsable = 0;
  let poUsable = 0;
  let holeSlotWeeks = 0;
  let holeWeeks = 0;
  const weekly_totals: RosRosterValue["weekly_totals"] = [];
  const poSet = new Set(ctx.ros.playoff_weeks);

  const byeThisWeek = (w: number, id: string): boolean => {
    const team = (playerMap.get(id)?.nfl_team ?? "").toUpperCase();
    return Boolean(team && ctx.ros.bye_weeks_by_team.get(team)?.has(w));
  };

  for (const w of ctx.ros.weeks) {
    // players on a schedule-verified bye are UNAVAILABLE this week: strip them
    // from BOTH the candidate roster and the projection batch, so the optimizer
    // starts a real backup if one exists and leaves the slot a genuine hole if
    // not (rather than parking the bye player there as an "unknown").
    const availableIds = activeIds.filter((id) => !byeThisWeek(w, id));
    const weekRoster: CanonicalRoster = {
      ...roster,
      all_players: roster.all_players.filter((id) => availableIds.includes(id) || reserve.has(id)),
      starters: roster.starters.filter((id) => availableIds.includes(id)),
      bench: roster.bench.filter((id) => availableIds.includes(id)),
      slots: roster.slots.filter((s) => s.canonical_player_id == null || availableIds.includes(s.canonical_player_id) || reserve.has(s.canonical_player_id)),
    };
    const batch = rosWeekBatch(w, ctx.season, availableIds, signalById, ctx.players_by_id, ctx.ros);
    const lineup = buildOptimalLineup({ week: w, roster: weekRoster, constraints: ctx.constraints, players: playerMap, projections: batch });
    const total = lineup.optimal_total ?? lineup.known_optimal_subtotal;
    usable += total;
    if (poSet.has(w)) poUsable += total;
    else regUsable += total;
    const empties = lineup.empty_slots.length;
    holeSlotWeeks += empties;
    if (empties > 0) holeWeeks += 1;
    weekly_totals.push({ week: w, total: round2(total), empty_slots: empties });
  }

  const standalone = activeIds.reduce((s, id) => s + (signalById.get(id)?.ros_points ?? 0), 0);

  return {
    usable_ros_points: round2(usable),
    regular_season_usable: round2(regUsable),
    playoff_window_usable: round2(poUsable),
    standalone_ros_points: round2(standalone),
    stranded_ros_points: round2(Math.max(0, standalone - usable)),
    bye_hole_slot_weeks: holeSlotWeeks,
    bye_hole_weeks: holeWeeks,
    weekly_totals,
    uncovered_player_ids: uncovered,
  };
}

/* -------------------------------------------------- per-participant evaluation */

export interface RosEvalInput {
  ctx: TradeAnalysisContext;
  manager_id: string;
  before: CanonicalRoster;
  after: CanonicalRoster;
  incoming_ids: string[];
  outgoing_ids: string[];
}

export function evaluateRosParticipant(input: RosEvalInput): RosParticipantResult {
  const { ctx, before, after, incoming_ids, outgoing_ids } = input;
  const diagnostics: TradeDiagnostic[] = [];

  const relevantIds = new Set<string>([...before.all_players, ...after.all_players]);
  const signalById = new Map<string, RosPlayerSignal>();
  for (const id of relevantIds) {
    signalById.set(id, rosSignalFor(id, ctx.players_by_id, ctx.projections, ctx.ros));
  }

  const beforeVal = rosRosterValue(before, ctx, signalById);
  const afterVal = rosRosterValue(after, ctx, signalById);

  const uncovered = [...new Set([...beforeVal.uncovered_player_ids, ...afterVal.uncovered_player_ids])];
  if (uncovered.length > 0) {
    diagnostics.push({
      code: "ROS_PARTIAL_PLAYER_COVERAGE",
      message: `${uncovered.length} rostered player(s) have no rest-of-season signal and were excluded from the ROS lineup (never zeroed): ${uncovered.join(", ")}.`,
      severity: "warning",
    });
  }
  if (ctx.ros.schedule_status !== "READY") {
    diagnostics.push({
      code: "BYE_DATA_UNAVAILABLE",
      message: `ROS byes verified for ${ctx.ros.weeks_with_verified_schedule.length}/${ctx.ros.weeks.length} remaining weeks.`,
      severity: ctx.ros.schedule_status === "UNAVAILABLE" ? "warning" : "info",
    });
  }

  const usableDelta = round2(afterVal.usable_ros_points - beforeVal.usable_ros_points);
  const regDelta = round2(afterVal.regular_season_usable - beforeVal.regular_season_usable);
  const poDelta = ctx.ros.playoff_window_available
    ? round2(afterVal.playoff_window_usable - beforeVal.playoff_window_usable)
    : null;
  const byeCoverageDelta = beforeVal.bye_hole_slot_weeks - afterVal.bye_hole_slot_weeks;

  const inStandalone = incoming_ids.reduce((s, id) => s + (signalById.get(id)?.ros_points ?? 0), 0);
  const outStandalone = outgoing_ids.reduce((s, id) => s + (signalById.get(id)?.ros_points ?? 0), 0);
  const standaloneRosSwing = round2(inStandalone - outStandalone);

  // ---- leave-one-out marginal utility per transferred player
  const marginal: MarginalPlayerUtility[] = [];
  const looRos = (roster: CanonicalRoster, dropId: string): number => {
    const stripped: CanonicalRoster = {
      ...roster,
      all_players: roster.all_players.filter((id) => id !== dropId),
      starters: roster.starters.filter((id) => id !== dropId),
      bench: roster.bench.filter((id) => id !== dropId),
      ir: roster.ir.filter((id) => id !== dropId),
      taxi: roster.taxi.filter((id) => id !== dropId),
      slots: roster.slots.filter((s) => s.canonical_player_id !== dropId),
    };
    return rosRosterValue(stripped, ctx, signalById).usable_ros_points;
  };
  const wp = (id: string) => ctx.projections.by_player.get(id) ?? null;
  for (const id of incoming_ids) {
    const withP = afterVal.usable_ros_points;
    const withoutP = looRos(after, id);
    marginal.push({
      canonical_player_id: id,
      direction: "INCOMING",
      standalone_weekly_projection: wp(id)?.projected_points ?? null,
      standalone_ros_projection: signalById.get(id)?.ros_points ?? null,
      marginal_ros_delta: round2(withP - withoutP),
      marginal_starter_delta: null,
    });
  }
  for (const id of outgoing_ids) {
    const withP = beforeVal.usable_ros_points;
    const withoutP = looRos(before, id);
    marginal.push({
      canonical_player_id: id,
      direction: "OUTGOING",
      standalone_weekly_projection: wp(id)?.projected_points ?? null,
      standalone_ros_projection: signalById.get(id)?.ros_points ?? null,
      // a loss: what the roster gives up ROS-wise once it reshuffles to cover
      marginal_ros_delta: round2(-(withP - withoutP)),
      marginal_starter_delta: null,
    });
  }
  const interactionResidual = round2(usableDelta - marginal.reduce((s, m) => s + (m.marginal_ros_delta ?? 0), 0));

  // ---- usable concentration = Herfindahl index of the roster's ROS weekly-mean
  // pool (Σ squared shares; 0 = perfectly even, 1 = one player). Structural
  // (O(players)) — a weight-0 descriptive metric, not worth an exact
  // marginal-attribution pass. Consolidating several mid pieces into one bigger
  // one RAISES the HHI even when the single best player is unchanged.
  const concentration = (roster: CanonicalRoster): number => {
    const reserve = new Set([...roster.ir, ...roster.taxi]);
    const means = roster.all_players
      .filter((id) => !reserve.has(id))
      .map((id) => signalById.get(id)?.ros_weekly_mean ?? 0)
      .filter((m) => m > 0);
    const pool = means.reduce((s, m) => s + m, 0);
    if (pool <= 0) return 0;
    return round2(means.reduce((s, m) => s + (m / pool) ** 2, 0) * 1000) / 1000;
  };
  const concBefore = concentration(before);
  const concAfter = concentration(after);
  const consolidation = Math.round((concAfter - concBefore) * 1000) / 1000;
  const playerCountDelta = after.all_players.length - before.all_players.length;
  let shape: RosParticipantResult["roster_shape_delta"] = "NEUTRAL";
  if (consolidation > 0.004 && playerCountDelta <= 0 && usableDelta > -0.5) shape = "STAR_CONCENTRATION";
  else if (consolidation < -0.004 && playerCountDelta >= 0) shape = "DEPTH_DISTRIBUTION";

  return {
    before: beforeVal,
    after: afterVal,
    ros_usable_value_delta: usableDelta,
    regular_season_ros_delta: regDelta,
    playoff_window_delta: poDelta,
    bye_coverage_delta: byeCoverageDelta,
    standalone_ros_swing: standaloneRosSwing,
    marginal_player_utility: marginal,
    interaction_residual: interactionResidual,
    usable_concentration_before: concBefore,
    usable_concentration_after: concAfter,
    consolidation_effect: consolidation,
    roster_shape_delta: shape,
    diagnostics,
  };
}
