/**
 * W1.R2 — the ONE canonical asset (hold) value, and the forward-availability semantics it shares with the trade horizon.
 *
 * Three questions, three views. They may share evidence; they are never the same number:
 *
 *   current_week   "what can he score THIS week?"                 -> the canonical current-week expected points (lineup, matchup, add benefit)
 *   forward_value  "what does he produce over the remaining weeks?" -> existing ROS evidence (provider ROS, or the RI season benchmark)
 *   asset_value    "what am I giving up if I let him go?"           -> per-week hold value, NEUTRAL to temporary current-week states
 *
 * A temporary current-week condition (verified bye, Questionable / Doubtful / Out / official inactive) says something about THIS week only: a
 * Questionable tag changes nothing; a bye / Doubtful / Out designation suppresses this week's number, and the hold value then rests on the
 * evidence that remains (a positive pre-bye projection, or forward ROS). No temporary condition applies a penalty of its own — but forward ROS
 * tracks a season average, so it can sit below a breakout player's current role (flagged on waiver recommendations). A long-term condition (IR / PUP / NFI / suspension) is a genuine
 * forward impairment: the NFL's minimum stint (LONG_TERM_MIN_GAMES_OUT) is removed from the forward horizon. A season-ending absence lowers the
 * asset value only to the extent the FORWARD evidence reflects it (a provider ROS that collapses): Bloodline has no injury-timeline evidence of
 * its own, and the RI season benchmark is static. When the forward evidence does not react, a season-ending player is protected rather than
 * dropped — the conservative failure, documented as a limitation. There is no blanket injury protection: low forward evidence is droppable.
 *
 * Evidence (no new scoring model, no hand-tuned weights) — the FRESHEST evidence the condition has not suppressed:
 *   no condition / Questionable  the current source projection (the legacy hold value: healthy decisions do not move)
 *   verified bye                 a POSITIVE pre-bye source projection (if he would otherwise play) -> forward ROS rate -> UNKNOWN.
 *                                A literal 0 on a bye is the schedule speaking, not evidence about the player (W1.R2 / P1-C).
 *   Doubtful / Out / inactive    forward ROS rate -> UNKNOWN (the current number is suppressed by the condition itself)
 *   long-term injury             forward ROS rate x (1 - minimum stint / horizon) -> UNKNOWN
 *
 * UNKNOWN is null, never 0: a consumer must not read "no evidence" as "cheap". Pure: no I/O, no clock. Provider-neutral: keyed by the row the
 * caller already holds (canonical identity); no provider id is read.
 */
import type { WeeklyProjection } from "../schema";
import { holdHorizonWeeks, isVerifiedBye, type HoldBasis } from "./bye";
import { normalizeInjuryStatus, type NormalizedInjuryState } from "./injury-model";

export const ASSET_VALUE_VERSION = "asset-value-2026.1" as const;

/** NFL roster rule: IR / PUP / NFI placement sidelines a player for at least four games. A rule, not a fitted parameter. */
export const LONG_TERM_MIN_GAMES_OUT = 4;

/** row warning written by the weekly context when a bye row's ROS came from the RI season benchmark (W1.R1) */
const RI_ROS_WARNING = "bye_hold_ros_from_ri_season_benchmark";

export type CurrentWeekCondition = "NONE" | "BYE" | "INJURY_SHORT_TERM" | "INJURY_LONG_TERM";

/** The repo's hold-basis vocabulary (W1.P3), extended. `CURRENT_WEEK_NOT_BYE` keeps its legacy name: a player with no temporary condition. */
export type AssetBasis = HoldBasis | "RI_ROS_BENCHMARK" | "QUESTIONABLE_SOURCE";

export type ForwardBasis = "ROS_PROJECTION" | "RI_ROS_BENCHMARK" | "UNAVAILABLE";

export interface CanonicalAssetView {
  version: typeof ASSET_VALUE_VERSION;
  current_week: {
    expected_points: number | null;
    playable: boolean;
    condition: CurrentWeekCondition;
    temporary_unavailability_reason: "BYE" | "INJURY" | null;
    normalized_injury_state: NormalizedInjuryState;
  };
  forward_value: {
    ros_points: number | null;
    /** ros_points spread over the remaining horizon; null = unknown */
    weekly_rate: number | null;
    horizon_weeks: number;
    basis: ForwardBasis;
    /** weeks of the forward horizon (this week included) the player is expected to MISS. 0 for every current-week-only condition. */
    forward_weeks_out: number;
  };
  asset_value: {
    /** per-week hold value in league points; null = UNKNOWN (never 0) */
    hold_points_per_week: number | null;
    basis: AssetBasis;
    /** always false: a temporary current-week state never lowers the asset value (the field exists so explanations can say so) */
    temporary_current_week_penalty_applied: false;
    /** true only for a long-term condition, where the minimum stint is removed from the forward rate */
    forward_impairment_applied: boolean;
    explanation: string;
  };
}

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;

const SHORT_TERM: ReadonlySet<NormalizedInjuryState> = new Set(["QUESTIONABLE", "DOUBTFUL", "OUT", "OFFICIAL_INACTIVE"]);
const LONG_TERM: ReadonlySet<NormalizedInjuryState> = new Set(["INJURED_RESERVE", "UNAVAILABLE_LIST"]);
/** short-term states whose current-week source number is suppressed by the condition (Questionable is NOT: he usually plays) */
const SHORT_TERM_SUPPRESSING: ReadonlySet<NormalizedInjuryState> = new Set(["DOUBTFUL", "OUT", "OFFICIAL_INACTIVE"]);

export function currentWeekCondition(row: Pick<WeeklyProjection, "is_bye" | "projection_status" | "injury_status"> | null | undefined): CurrentWeekCondition {
  if (!row) return "NONE";
  const s = normalizeInjuryStatus(row.injury_status);
  if (isVerifiedBye(row)) return "BYE";
  if (LONG_TERM.has(s)) return "INJURY_LONG_TERM";
  if (SHORT_TERM.has(s)) return "INJURY_SHORT_TERM";
  return "NONE";
}

/** Forward availability shared by the asset value and the trade horizon. Current-week-only conditions miss 0 forward weeks. */
export function forwardWeeksOut(row: Pick<WeeklyProjection, "is_bye" | "projection_status" | "injury_status"> | null | undefined, horizonWeeks: number): number {
  const s = row ? normalizeInjuryStatus(row.injury_status) : "HEALTHY";
  return LONG_TERM.has(s) ? Math.min(Math.max(1, horizonWeeks), LONG_TERM_MIN_GAMES_OUT) : 0;
}

export function canonicalAssetValue(a: {
  row: WeeklyProjection | null | undefined;
  week: number;
  /** the canonical forecast's pre-bye underlying value, when the context has one (only meaningful on a verified bye) */
  pre_bye_source_points?: number | null;
  /** the canonical current-week expected points, when the caller has the forecast (display only; never used as asset value) */
  current_week_expected_points?: number | null;
}): CanonicalAssetView {
  const row = a.row ?? null;
  const horizon = holdHorizonWeeks(a.week);
  const condition = currentWeekCondition(row);
  const state = normalizeInjuryStatus(row?.injury_status);
  const ros = row?.rest_of_season_points ?? null;
  const fwdBasis: ForwardBasis = ros == null ? "UNAVAILABLE" : row?.warnings?.includes(RI_ROS_WARNING) ? "RI_ROS_BENCHMARK" : "ROS_PROJECTION";
  const rate = ros == null ? null : r2(ros / horizon);
  const weeksOut = forwardWeeksOut(row, horizon);
  const expected = a.current_week_expected_points !== undefined ? a.current_week_expected_points : (row?.projected_points ?? null);

  const fwdHoldBasis: AssetBasis = fwdBasis === "RI_ROS_BENCHMARK" ? "RI_ROS_BENCHMARK" : "ROS_PER_WEEK_PROXY";
  // W1.R2 rule — the hold value rests on the FRESHEST evidence that this week's condition has NOT suppressed:
  //   no condition / Questionable   this week's source projection (Questionable players usually play: the number is valid). Exactly the legacy
  //                                 value, so healthy decisions do not move — and a static/preseason ROS never overrides fresh in-season evidence
  //                                 (re-audit: a uniform max(projection, ROS) protected stale-ROS busts and suppressed breakout adds).
  //   verified bye                  a POSITIVE pre-bye projection when he would otherwise play (a literal 0 on a bye is the schedule — P1-C),
  //                                 else the forward ROS rate.
  //   Doubtful / Out / inactive     the forward ROS rate: the current number is suppressed by the condition, forward evidence is all there is.
  //   long-term (IR/PUP/NFI/SUS)    the forward rate reduced by the NFL minimum stint.
  // Properties: a Questionable tag never changes the hold value (same evidence as healthy); Doubtful / Out / inactive share one basis; a long-term
  // condition never raises it; a bye never lowers it below forward evidence. A healthy player and an Out player rest on DIFFERENT evidence (a
  // playable week vs. forward evidence only) — that difference is the definition, not a ranking of states.
  let impaired = false;
  const candidates: Array<{ v: number; basis: AssetBasis }> = [];
  if (row) {
    const longTerm = LONG_TERM.has(state);
    const fwd = rate == null ? null : longTerm ? r2(rate * Math.max(0, (horizon - weeksOut) / horizon)) : rate;
    if (longTerm && fwd != null) impaired = true;
    const pre = a.pre_bye_source_points;
    if (condition === "NONE" || (condition === "INJURY_SHORT_TERM" && state === "QUESTIONABLE")) {
      if (row.projected_points != null) candidates.push({ v: row.projected_points, basis: condition === "NONE" ? "CURRENT_WEEK_NOT_BYE" : "QUESTIONABLE_SOURCE" });
    } else if (condition === "BYE") {
      // the same hierarchy whatever his injury state, THEN the long-term impairment — so a long-term condition can only lower the bye value. A
      // Doubtful/Out designation on a bye week suppresses the pre-bye number like any other current number.
      const suppressed = SHORT_TERM_SUPPRESSING.has(state);
      const factor = longTerm ? Math.max(0, (horizon - weeksOut) / horizon) : 1;
      if (!suppressed && pre != null && pre > 0) candidates.push({ v: r2(pre * factor), basis: "SOURCE_PROJECTION_PRE_BYE" });
      else if (fwd != null) candidates.push({ v: fwd, basis: fwdHoldBasis });
    } else if (fwd != null) {
      candidates.push({ v: fwd, basis: fwdHoldBasis });
    }
  }
  // ties keep the earlier (more specific) basis: current source, then pre-bye source, then the forward rate
  const best = candidates.reduce<{ v: number; basis: AssetBasis } | null>((m, c) => (m == null || c.v > m.v ? c : m), null);
  const hold: number | null = best?.v ?? null;
  const basis: AssetBasis = best?.basis ?? (row && condition === "NONE" ? "CURRENT_WEEK_NOT_BYE" : "UNAVAILABLE");
  const evidence = basis === "CURRENT_WEEK_NOT_BYE" ? "the current source projection" : basis === "QUESTIONABLE_SOURCE" ? "the current source projection (Questionable players usually play)" : basis === "SOURCE_PROJECTION_PRE_BYE" ? "the pre-bye source projection" : basis === "RI_ROS_BENCHMARK" ? "the RI rest-of-season benchmark" : "the rest-of-season projection";
  let explanation: string;
  if (!row) explanation = "No projection row: asset value is unknown (not low).";
  else if (hold == null) explanation = `${condition === "NONE" ? "No current projection" : condition === "BYE" ? "Verified bye with no positive pre-bye projection" : `${row.injury_status} this week`} and no rest-of-season evidence: asset value is unknown (not low).`;
  else if (condition === "NONE") explanation = `No temporary condition: hold value ${hold}/wk rests on ${evidence}.`;
  else if (condition === "BYE") explanation = `Current-week points are 0 because of a verified bye; hold value ${hold}/wk rests on ${evidence}${impaired ? ` (reduced: ${row.injury_status} removes at least ${weeksOut} of ${horizon} weeks)` : ""}.`;
  else if (condition === "INJURY_SHORT_TERM") explanation = `${row.injury_status} is treated as a temporary current-week availability state: current-week value is reduced, hold value stays ${hold}/wk (${evidence}).`;
  else explanation = `${row.injury_status} is a forward impairment: at least ${weeksOut} of ${horizon} remaining weeks are removed, hold value ${hold}/wk (${evidence}).`;

  const playable = condition === "NONE" || (condition === "INJURY_SHORT_TERM" && state === "QUESTIONABLE");
  return {
    version: ASSET_VALUE_VERSION,
    current_week: {
      expected_points: expected,
      playable: playable && expected != null,
      condition,
      temporary_unavailability_reason: condition === "BYE" ? "BYE" : condition === "NONE" ? null : "INJURY",
      normalized_injury_state: state,
    },
    forward_value: { ros_points: ros, weekly_rate: rate, horizon_weeks: horizon, basis: fwdBasis, forward_weeks_out: weeksOut },
    asset_value: { hold_points_per_week: hold, basis, temporary_current_week_penalty_applied: false, forward_impairment_applied: impaired, explanation },
  };
}

export interface HoldWeeklyValue {
  /** per-week hold value in league points; null = unknown (NOT 0) */
  points: number | null;
  basis: AssetBasis;
}

/**
 * The drop-side / asset question, as `{ points, basis }` — a view over `canonicalAssetValue` (the ONLY implementation). Kept under the W1.P3 name so
 * every existing caller reads the same substrate. `underlying_points` is the canonical forecast's pre-bye underlying value, when available.
 */
export function holdWeeklyValue(args: { row: WeeklyProjection | null | undefined; underlying_points?: number | null; week: number }): HoldWeeklyValue {
  const v = canonicalAssetValue({ row: args.row, week: args.week, pre_bye_source_points: args.underlying_points ?? null });
  return { points: v.asset_value.hold_points_per_week, basis: v.asset_value.basis };
}
