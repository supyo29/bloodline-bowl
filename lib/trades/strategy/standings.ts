/**
 * Trade Engine — Phase 6B: standings and playoff context.
 *
 * Reuses `snapshot.standings` (already computed by the provider layer —
 * `wins desc, then points_for` — see `lib/providers/sleeper/canonical.ts`).
 * No divisions, reseeding, or precise tiebreak data is available upstream;
 * this module exposes that uncertainty rather than fabricating precision
 * (spec §5/§6). Playoff odds are NEVER a fabricated percentage — either a
 * documented deterministic model backs a number, or the field is `null` with
 * an explicit diagnostic (spec §7/§8/§9).
 */

import type { TradeAnalysisContext } from "../context";
import type { LeagueSeasonContext, ManagerStandingsContext, PlayoffContext, PlayoffStatus } from "./types";
import { BUBBLE_GAMES_BACK_MAX, isClinchSafe, LONG_SHOT_GAMES_BACK_MAX, MIN_GAMES_PLAYED_FOR_STATUS } from "./config";

export function buildManagerStandings(ctx: TradeAnalysisContext, managerId: string): ManagerStandingsContext {
  const team = ctx.snapshot.teams.find((t) => t.canonical_manager_ids.includes(managerId));
  if (!team) {
    return {
      canonical_team_id: null, rank: null, wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0,
      games_played: 0, win_percentage: null, playoff_seed: null, standings_available: false,
    };
  }
  const standing = ctx.snapshot.standings.find((s) => s.canonical_team_id === team.canonical_team_id);
  if (!standing) {
    return {
      canonical_team_id: team.canonical_team_id, rank: null, wins: team.record.wins, losses: team.record.losses,
      ties: team.record.ties, points_for: team.record.points_for, points_against: team.record.points_against,
      games_played: team.record.wins + team.record.losses + team.record.ties, win_percentage: null,
      playoff_seed: null, standings_available: false,
    };
  }
  return {
    canonical_team_id: standing.canonical_team_id, rank: standing.rank, wins: standing.wins, losses: standing.losses,
    ties: standing.ties, points_for: standing.points_for, points_against: standing.points_against,
    games_played: standing.games_played, win_percentage: standing.win_percentage,
    playoff_seed: standing.playoff_seed, standings_available: true,
  };
}

/**
 * "Games back" of the current last-playoff-spot team, using the same
 * win-percentage-driven ranking the provider already applies to `rank`
 * (wins, then points_for) — a coarse but honest distance metric. Returns
 * null when standings or a resolvable playoff cutline are unavailable.
 */
function gamesBackOfCutline(ctx: TradeAnalysisContext, standing: ManagerStandingsContext, playoffTeamCount: number | null): number | null {
  if (!standing.standings_available || standing.rank == null || playoffTeamCount == null || playoffTeamCount <= 0) return null;
  const all = ctx.snapshot.standings.slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (all.length === 0) return null;
  const cutlineIdx = Math.min(playoffTeamCount, all.length) - 1;
  const cutlineTeam = all[cutlineIdx];
  if (!cutlineTeam) return null;
  if (standing.rank <= playoffTeamCount) {
    // Already inside the line: report how many games clear of being bumped
    // (distance to the first team just outside), as a NEGATIVE games-back
    // value would be confusing — report clearance separately via status logic.
    const firstOut = all[playoffTeamCount];
    if (!firstOut) return 0; // no team outside the line at all (playoff_team_count >= league size)
    const clearanceWins = (standing.wins + standing.ties * 0.5) - (firstOut.wins + firstOut.ties * 0.5);
    return -Math.max(0, clearanceWins); // negative = clear by this many "games"
  }
  const gamesBack = (cutlineTeam.wins + cutlineTeam.ties * 0.5) - (standing.wins + standing.ties * 0.5);
  return Math.max(0, Math.round(gamesBack * 10) / 10);
}

/**
 * Playoff status classification (spec §6): uses real standings + season
 * timing, never rank alone. A team can be mathematically CLINCHED only when
 * clearly ahead of the cutline AND few weeks remain (a crude but honest
 * proxy for "opponents cannot catch up" absent a real clinching-scenario
 * solver); anything else inside the line is STRONG_POSITION.
 */
export function classifyPlayoffStatus(
  ctx: TradeAnalysisContext,
  standing: ManagerStandingsContext,
  season: LeagueSeasonContext,
): PlayoffContext {
  const diagnostics: string[] = [];
  if (!standing.standings_available) {
    diagnostics.push("STANDINGS_UNAVAILABLE");
    return { status: "UNKNOWN", games_back: null, playoff_odds: null, playoff_odds_band: null, diagnostics };
  }
  if (season.playoff_team_count == null) {
    diagnostics.push("PLAYOFF_CONTEXT_UNAVAILABLE");
    return { status: "UNKNOWN", games_back: null, playoff_odds: null, playoff_odds_band: null, diagnostics };
  }
  if (standing.games_played < MIN_GAMES_PLAYED_FOR_STATUS) {
    diagnostics.push("INSUFFICIENT_GAMES_PLAYED");
    return { status: "UNKNOWN", games_back: null, playoff_odds: null, playoff_odds_band: null, diagnostics };
  }
  const gb = gamesBackOfCutline(ctx, standing, season.playoff_team_count);
  let status: PlayoffStatus = "UNKNOWN";
  if (gb == null) {
    diagnostics.push("PLAYOFF_CONTEXT_UNAVAILABLE");
  } else if (gb <= 0) {
    const clearance = -gb;
    status = isClinchSafe(clearance, season.weeks_remaining_regular) ? "CLINCHED" : "STRONG_POSITION";
  } else if (gb <= BUBBLE_GAMES_BACK_MAX) {
    status = "BUBBLE";
  } else if (gb <= LONG_SHOT_GAMES_BACK_MAX) {
    status = "LONG_SHOT";
  } else {
    // Mathematically eliminated only when even winning out cannot close the
    // gap (at most 1 "game" of ground per remaining week) — a real, checkable
    // condition, not a guess based on rank alone (spec §6).
    status = gb > season.weeks_remaining_regular ? "ELIMINATED" : "LONG_SHOT";
  }

  // Spec §7/§8/§9: playoff odds are never a fabricated percentage. This
  // repository has no deterministic season-simulation infrastructure
  // (real remaining schedules × a real scoring-distribution model, run with
  // a fixed seed) — building one is out of this phase's scope (see
  // docs/TRADE_ENGINE_PHASE6.md §L "remaining limitations"). Odds stay null;
  // a coarse categorical band, itself clearly derived (not fitted), is
  // offered instead of raw numeric status, matching the spec's preference
  // for bands over unsupported precision.
  diagnostics.push("PLAYOFF_ODDS_UNAVAILABLE");
  const band = gb == null ? null : gb <= 0 ? (status === "CLINCHED" ? "VERY_HIGH" : "HIGH") : gb <= BUBBLE_GAMES_BACK_MAX ? "MEDIUM" : gb <= LONG_SHOT_GAMES_BACK_MAX ? "LOW" : "VERY_LOW";

  return { status, games_back: gb == null ? null : Math.max(0, gb), playoff_odds: null, playoff_odds_band: band, diagnostics };
}
