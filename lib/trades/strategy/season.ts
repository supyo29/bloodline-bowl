/**
 * Trade Engine — Phase 6A: season-state context.
 *
 * Built ONCE per league snapshot (see `profile.ts`).
 *
 * Audit fix (§3, P1): the original implementation called
 * `resolveRosWeekPlan` a SECOND time, independently, using
 * `ps.championship_week ?? null` (no fallback) — while
 * `buildTradeAnalysisContext` (Phase 2) calls the SAME function with
 * `ps.championship_week ?? DEFAULT_CHAMPIONSHIP_WEEK` (a real fallback,
 * `17`). For a league whose `championship_week` setting is unresolved, this
 * meant Phase 6 reported `championship_week: null` /
 * `weeks_remaining_total: 0` while `ctx.ros` (Phase 2's OWN already-computed
 * plan, sitting right there on the same `TradeAnalysisContext`) held a real,
 * non-null plan — a second, incompatible interpretation of playoff weeks,
 * exactly what the spec prohibits. Fixed by reading `ctx.ros` DIRECTLY
 * instead of re-deriving anything — there is now no second call to
 * `resolveRosWeekPlan` anywhere in this file, and no possible divergence.
 */

import type { TradeAnalysisContext } from "../context";
import type { LeagueSeasonContext, SeasonStage } from "./types";
import { MIDSEASON_FRACTION, PLAYOFF_PUSH_WEEKS_REMAINING } from "./config";

const DEFAULT_REGULAR_SEASON_START_WEEK = 1;

/**
 * Season stage, derived from league geometry (fraction of the regular season
 * elapsed, weeks remaining before the playoff cutover) rather than hardcoded
 * NFL week numbers, per spec §2.
 */
function classifySeasonStage(input: {
  week: number;
  regularSeasonStartWeek: number;
  playoffStartWeek: number | null;
  championshipWeek: number | null;
}): SeasonStage {
  const { week, regularSeasonStartWeek, playoffStartWeek, championshipWeek } = input;
  if (week < regularSeasonStartWeek) return "PRESEASON";
  if (championshipWeek != null && week > championshipWeek) return "SEASON_COMPLETE";
  if (playoffStartWeek != null && week >= playoffStartWeek) return "FANTASY_PLAYOFFS";
  if (playoffStartWeek != null) {
    const weeksUntilPlayoffs = playoffStartWeek - week;
    if (weeksUntilPlayoffs <= PLAYOFF_PUSH_WEEKS_REMAINING) return "PLAYOFF_PUSH";
    const regularSeasonLength = playoffStartWeek - regularSeasonStartWeek;
    const elapsed = week - regularSeasonStartWeek;
    if (regularSeasonLength > 0 && elapsed / regularSeasonLength >= MIDSEASON_FRACTION) return "MIDSEASON";
    return "EARLY_SEASON";
  }
  // No resolvable playoff start at all — fall back to a coarse elapsed-week
  // heuristic against a typical ~14-week regular season, clearly
  // diagnostic-only (this branch only fires when `ctx.ros.playoff_start_week`
  // itself is null, i.e. Phase 2 also could not resolve one).
  const elapsed = week - regularSeasonStartWeek;
  if (elapsed < 0) return "UNKNOWN";
  return elapsed >= 6 ? "MIDSEASON" : "EARLY_SEASON";
}

export function buildLeagueSeasonContext(ctx: TradeAnalysisContext): LeagueSeasonContext {
  const week = ctx.week;
  const season = ctx.season;
  const ps = ctx.snapshot.league.playoff_settings;
  const regularSeasonStartWeek = DEFAULT_REGULAR_SEASON_START_WEEK;

  // Read Phase 2's OWN already-computed plan directly — no second
  // `resolveRosWeekPlan` call, no possible divergence (see fix note above).
  const ros = ctx.ros;
  const playoffStartWeek = ros.playoff_start_week;
  const championshipWeek = ros.championship_week;
  const regularSeasonEndWeek =
    playoffStartWeek != null ? playoffStartWeek - 1 : ros.regular_season_weeks.length > 0 ? ros.regular_season_weeks[ros.regular_season_weeks.length - 1]! : null;

  const weeksRemainingTotal = ros.weeks.length;
  const weeksRemainingRegular = ros.regular_season_weeks.length;

  const season_stage = classifySeasonStage({ week, regularSeasonStartWeek, playoffStartWeek, championshipWeek });

  return {
    season,
    week,
    regular_season_start_week: regularSeasonStartWeek,
    regular_season_end_week: regularSeasonEndWeek,
    playoff_start_week: playoffStartWeek,
    championship_week: championshipWeek,
    weeks_remaining_regular: weeksRemainingRegular,
    weeks_remaining_total: weeksRemainingTotal,
    playoff_team_count: ps.playoff_team_count ?? null,
    season_stage,
    // Spec §3: "Do not invent a deadline if none exists." The canonical
    // snapshot pipeline this context is built from does not surface a
    // resolvable trade-deadline field today (see docs/TRADE_ENGINE_PHASE6.md
    // §B) — honestly reported unresolved rather than fabricated.
    trade_deadline_week: null,
    trade_deadline_status: "UNKNOWN",
  };
}
