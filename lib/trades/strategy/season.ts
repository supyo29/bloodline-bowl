/**
 * Trade Engine — Phase 6A: season-state context.
 *
 * Built ONCE per league snapshot (see `profile.ts`), reusing the SAME week
 * geometry Phase 2 already audited (`resolveRosWeekPlan`) — never a second,
 * incompatible interpretation of playoff weeks.
 */

import type { TradeAnalysisContext } from "../context";
import { resolveRosWeekPlan } from "../context";
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
  // No resolvable playoff start — fall back to a coarse elapsed-week heuristic
  // against a typical ~14-week regular season, clearly diagnostic-only.
  const elapsed = week - regularSeasonStartWeek;
  if (elapsed < 0) return "UNKNOWN";
  return elapsed >= 11 ? "MIDSEASON" : elapsed >= 6 ? "MIDSEASON" : "EARLY_SEASON";
}

export function buildLeagueSeasonContext(ctx: TradeAnalysisContext): LeagueSeasonContext {
  const week = ctx.week;
  const season = ctx.season;
  const ps = ctx.snapshot.league.playoff_settings;
  const regularSeasonStartWeek = DEFAULT_REGULAR_SEASON_START_WEEK;
  const championshipWeek = ps.championship_week ?? null;
  const plan =
    championshipWeek != null
      ? resolveRosWeekPlan(week, championshipWeek, ps.playoff_start_week)
      : null;
  const playoffStartWeek = plan?.playoff_start_week ?? null;
  const regularSeasonEndWeek = playoffStartWeek != null ? playoffStartWeek - 1 : null;

  const weeksRemainingTotal = championshipWeek != null ? Math.max(0, championshipWeek - week + 1) : 0;
  const weeksRemainingRegular =
    regularSeasonEndWeek != null ? Math.max(0, regularSeasonEndWeek - week + 1) : weeksRemainingTotal;

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
