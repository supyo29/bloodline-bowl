/**
 * Historical weekly player-availability evidence, backing
 * `GET /api/player-availability` and `GET /api/manager-availability`.
 *
 * ============================================================================
 * PHASE 1 AUDIT — what Sleeper actually supports, and what it does not
 * ============================================================================
 *
 * Sleeper's public API has NO historical archive for injury designations,
 * official game-day inactive lists, or practice reports. Its player database
 * (`/players/nfl`) carries `injury_status`, `injury_notes`, and
 * `practice_participation` — but only as a CURRENT snapshot, overwritten in
 * place as the season progresses. There is no way to ask Sleeper "what was
 * this player's designation in week 4" — only "what is it right now." Using
 * that current value for a historical week would be exactly the leakage this
 * module must never produce, so this module never reads `injury_status` (or
 * any sibling field) at all. Those dimensions are unconditionally reported as
 * `"unsupported"` in `coverage.field_support` — not silently blank, not
 * approximated.
 *
 * What Sleeper DOES provide, and what this module builds from it:
 *
 *  1. Weekly stat lines (`/stats/nfl/regular/{season}/{week}`, via
 *     `lib/stats/provider.ts`) carry `gp` (games played) and `gms_active`
 *     (games active) per player-week — real, per-week, authoritative
 *     participation evidence. A missing key means no stat line was recorded,
 *     which is evidence of absence, not proof of a specific reason.
 *  2. That same dump carries one row per NFL team, keyed by the team's own
 *     2-3 letter code (e.g. `"HOU"`, `"KC"`) with defense/team-level stats —
 *     Sleeper's own scoring feed for team defenses. A team's `gp` on that row
 *     is a direct signal of whether the team played that week at all, which
 *     is exactly what a bye-week determination needs. The set of valid team
 *     codes is read from the player index itself (`position === "DEF"`),
 *     never hardcoded, so it can never drift from what Sleeper actually
 *     tracks.
 *  3. Weekly matchups/lineups (`buildLineupRows`, already backing
 *     `GET /api/lineups`) give real per-week roster/starter/bench membership
 *     — not an inference from the end-of-season roster.
 *  4. The CURRENT `/league/{id}/rosters` snapshot's `reserve` array is real,
 *     but for a finished historical season it reflects wherever the league
 *     was frozen at season's end — not a per-week timeline. There is no
 *     Sleeper endpoint that reports IR placement week-by-week. This module
 *     therefore only asserts IR for the trailing block of weeks (from the
 *     season-end reserve snapshot back to that player's last recorded
 *     participation) and labels it `evidence_granularity: "season_end_snapshot"`
 *     with `low` confidence — never a specific placement week.
 *  5. `RawTransaction.created` / `status_updated` are real per-transaction
 *     timestamps, already used elsewhere in the bridge — this module's
 *     records expose stable join keys (`season`, `week`, `player_id`,
 *     `manager_id`, `roster_id`) so R can join them to transactions itself,
 *     rather than duplicating transaction data into every availability row.
 *
 * No external, non-Sleeper source is used. Every field this module cannot
 * ground in one of the five sources above is left unconditionally `null` (or,
 * for entire dimensions Sleeper never supports, omitted from the emitted
 * classes altogether) — see the `AvailabilityClass` union below, which is
 * deliberately shorter than the union recommended in the original spec: only
 * classes this bridge can actually back with real Sleeper evidence are
 * emitted. `confirmed_injury`, the four injury-designation grades, both
 * `inactive_*` classes, `suspension`, `reserve_pup`, and `reserve_nfi` are
 * never produced, by construction — there is no code path that could emit
 * them, which is the strongest guarantee against fabrication available here.
 *
 * ============================================================================
 * SCOPE BOUND
 * ============================================================================
 *
 * Records are only produced for players who were on some roster in this
 * league at some point during the requested season (the same
 * draftable/rostered-player bound already used to keep `/api/player-weekly`'s
 * free-agent pool from exploding to the entire NFL — see that module's
 * history). An availability endpoint's natural consumer is roster/manager
 * analysis, and Sleeper's own weekly dump already covers every NFL player
 * separately via `/api/player-weekly` if a wider pool is ever needed.
 */

import { slimPlayer, type PlayerIndex } from "@/lib/sleeper/client";
import { buildLineupRows, type LineupRow } from "./historical-lineups";
import type {
  NormalizedPlayer,
  RawLeagueUser,
  RawMatchup,
  RawRoster,
} from "@/lib/sleeper/types";
import type { PlayerStatLine } from "@/lib/stats/types";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Only classes this bridge can back with real Sleeper evidence. See the
 * module docstring for exactly why the fuller recommended union is not used.
 */
export type AvailabilityClass =
  | "participated"
  | "bye"
  | "ir"
  | "did_not_play_unknown"
  | "unknown";

export type AvailabilityConfidence = "high" | "moderate" | "low";
export type EvidenceGranularity = "weekly" | "season_end_snapshot" | "unknown";

export interface AvailabilityRecord {
  league_selector: string;
  league_id: string;
  season: string;
  week: number;
  player_id: string;
  player_name: string;
  position: string | null;
  /** Sleeper's CURRENT metadata team — see historical-scoring.ts for the same caveat. */
  nfl_team: string | null;

  manager_id: string | null;
  roster_id: number | null;

  rostered: boolean;
  started: boolean;
  bench: boolean;
  /** Season-end reserve snapshot projected onto a trailing no-participation window — see docstring. */
  reserve_or_ir: boolean | null;

  scheduled_game: boolean | null;
  bye_week: boolean | null;

  game_played: boolean | null;
  player_participated: boolean | null;
  snap_or_participation_evidence_available: boolean;

  /** Always null — Sleeper has no historical injury-designation archive. See module docstring. */
  historical_injury_designation_raw: null;
  historical_injury_designation: null;
  /** Always null — no historical game-status archive. */
  historical_game_status: null;
  /** Always null — practice reports are optional per spec and unsupported here. */
  historical_practice_status: null;

  /** Always null — no historical official-inactive-list source. */
  inactive: null;
  official_inactive_evidence: null;

  /** Always null — no source can distinguish non-injury absences. */
  suspended: null;
  pup: null;
  nfi: null;
  reserve_status: string | null;
  other_unavailability_status: null;

  fantasy_points: number | null;

  availability_class: AvailabilityClass;
  availability_reason: string;
  availability_confidence: AvailabilityConfidence;

  evidence_sources: string[];
  evidence_flags: string[];
  evidence_granularity: EvidenceGranularity;

  started_previous_week: boolean | null;
  starts_prior_3_weeks: number | null;
  rostered_previous_week: boolean | null;

  consecutive_games_missed_before_week: number | null;
  consecutive_weeks_unavailable_before_week: number | null;
  returning_after_absence: boolean | null;
  first_game_back: boolean | null;

  /**
   * Always null. Establishing this requires a status-publication timestamp
   * this bridge does not have (see module docstring, source 4) — never
   * fabricated to look more decisive than the evidence supports.
   */
  known_before_transaction: null;

  resolved: boolean;
}

export interface AvailabilityCoverage {
  total_player_weeks: number;
  player_weeks_with_participation_evidence: number;
  player_weeks_with_injury_evidence: number;
  player_weeks_with_inactive_evidence: number;
  player_weeks_with_reserve_evidence: number;
  player_weeks_with_practice_evidence: number;
  unknown_player_weeks: number;
  by_confidence: Record<AvailabilityConfidence, number>;
  by_class: Record<AvailabilityClass, number>;
}

export type FieldSupport = "available" | "partial" | "unsupported";

export const AVAILABILITY_FIELD_SUPPORT: Record<string, FieldSupport> = {
  game_participation: "available",
  bye_week: "available",
  manager_roster_context: "available",
  reserve_or_ir: "partial",
  historical_injury_designation: "unsupported",
  historical_game_status: "unsupported",
  historical_practice_status: "unsupported",
  official_inactive: "unsupported",
  suspension_non_injury: "unsupported",
  known_before_transaction: "unsupported",
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function resolvePlayer(playerId: string, playerIndex: PlayerIndex): NormalizedPlayer {
  return playerIndex.get(playerId) ?? slimPlayer(playerId, undefined);
}

/** The NFL team code an availability check should key on: a defense's own id for DEF, else its metadata team. */
function nflTeamCodeFor(player: NormalizedPlayer): string | null {
  if (player.position === "DEF") return player.player_id;
  return player.team;
}

function participationFlags(stats: PlayerStatLine | undefined): {
  gamePlayed: boolean | null;
  participated: boolean | null;
  evidenceAvailable: boolean;
} {
  if (!stats) return { gamePlayed: null, participated: null, evidenceAvailable: false };
  const gp = stats.stats.gp;
  const gmsActive = stats.stats.gms_active;
  const hasAnyEvidence =
    typeof gp === "number" ||
    typeof gmsActive === "number" ||
    typeof stats.stats.gs === "number" ||
    typeof stats.stats.off_snp === "number" ||
    typeof stats.stats.def_snp === "number" ||
    typeof stats.stats.st_snp === "number";
  if (!hasAnyEvidence) return { gamePlayed: null, participated: null, evidenceAvailable: false };
  return {
    gamePlayed: typeof gp === "number" ? gp >= 1 : null,
    participated: typeof gmsActive === "number" ? gmsActive >= 1 : typeof gp === "number" ? gp >= 1 : null,
    evidenceAvailable: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export interface BuildAvailabilityInput {
  leagueSelector: string;
  leagueId: string;
  season: string;
  weeks: number[];
  matchupsByWeek: Map<number, RawMatchup[]>;
  /** Per-week raw stat lines; a week missing from this map means no data could be loaded. */
  statsByWeek: Map<number, PlayerStatLine[]>;
  rosters: RawRoster[];
  users: RawLeagueUser[];
  rosterPositions: string[];
  playerIndex: PlayerIndex;
}

export interface BuildAvailabilityOutput {
  records: AvailabilityRecord[];
  coverage: AvailabilityCoverage;
  unresolvedPlayerIds: string[];
}

export function buildAvailabilityRecords(
  input: BuildAvailabilityInput,
): BuildAvailabilityOutput {
  const {
    leagueSelector,
    leagueId,
    season,
    weeks,
    matchupsByWeek,
    statsByWeek,
    rosters,
    users,
    rosterPositions,
    playerIndex,
  } = input;

  const unresolved = new Set<string>();

  // Every NFL team code Sleeper actually tracks, sourced from the player
  // index itself (never hardcoded — see module docstring, source 2).
  const knownTeamCodes = new Set(
    [...playerIndex.values()].filter((p) => p.position === "DEF").map((p) => p.player_id),
  );

  // Lineup rows per week (reuses the already-tested /api/lineups builder).
  const lineupsByWeek = new Map<number, LineupRow[]>();
  for (const week of weeks) {
    const matchups = matchupsByWeek.get(week) ?? [];
    if (matchups.length === 0) {
      lineupsByWeek.set(week, []);
      continue;
    }
    const { rows } = buildLineupRows({
      leagueSelector,
      leagueId,
      season,
      week,
      matchups,
      rosters,
      users,
      rosterPositions,
      playerIndex,
    });
    lineupsByWeek.set(week, rows);
  }

  // Stat lines per week, keyed by player_id.
  const statsByWeekPlayer = new Map<number, Map<string, PlayerStatLine>>();
  for (const week of weeks) {
    const lines = statsByWeek.get(week) ?? [];
    statsByWeekPlayer.set(week, new Map(lines.map((line) => [line.player_id, line])));
  }

  // Which NFL teams had a game each week, from team-code defense stat rows.
  const teamsWithGameByWeek = new Map<number, Set<string>>();
  const teamSampleSizeByWeek = new Map<number, number>();
  for (const week of weeks) {
    const statMap = statsByWeekPlayer.get(week);
    const teams = new Set<string>();
    let sample = 0;
    if (statMap) {
      for (const code of knownTeamCodes) {
        const line = statMap.get(code);
        if (line && typeof line.stats.gp === "number") {
          sample += 1;
          if (line.stats.gp >= 1) teams.add(code);
        }
      }
    }
    teamsWithGameByWeek.set(week, teams);
    teamSampleSizeByWeek.set(week, sample);
  }

  // The full rostered-player universe for this league/season: any player who
  // appears in any week's lineup rows — see the module's "SCOPE BOUND" note.
  const rosteredPlayerIds = new Set<string>();
  for (const rows of lineupsByWeek.values()) {
    for (const row of rows) rosteredPlayerIds.add(row.player_id);
  }

  // Season-end reserve/IR snapshot, keyed by player_id -> true.
  const seasonEndReserve = new Set<string>();
  for (const roster of rosters) {
    for (const playerId of roster.reserve ?? []) seasonEndReserve.add(playerId);
  }

  // Index lineup rows by player_id -> (week -> LineupRow) for fast per-player lookups.
  const lineupByPlayer = new Map<string, Map<number, LineupRow>>();
  for (const [week, rows] of lineupsByWeek) {
    for (const row of rows) {
      let byWeek = lineupByPlayer.get(row.player_id);
      if (!byWeek) {
        byWeek = new Map();
        lineupByPlayer.set(row.player_id, byWeek);
      }
      byWeek.set(week, row);
    }
  }

  const sortedWeeks = [...weeks].sort((a, b) => a - b);
  const records: AvailabilityRecord[] = [];

  for (const playerId of [...rosteredPlayerIds].sort()) {
    const player = resolvePlayer(playerId, playerIndex);
    if (!player.resolved) unresolved.add(playerId);
    const teamCode = nflTeamCodeFor(player);
    const byWeek = lineupByPlayer.get(playerId) ?? new Map<number, LineupRow>();

    // Last week (in the requested range) this player actually participated —
    // used to bound how far back the IR trailing-window heuristic reaches.
    let lastParticipatedWeek: number | null = null;
    for (const week of sortedWeeks) {
      const stats = statsByWeekPlayer.get(week)?.get(playerId);
      const { gamePlayed } = participationFlags(stats);
      if (gamePlayed === true) lastParticipatedWeek = week;
    }

    // Per-week classification pass (need a first pass for continuity fields).
    const weekly: Array<{
      week: number;
      cls: AvailabilityClass;
      lineup: LineupRow | undefined;
    }> = [];

    for (const week of sortedWeeks) {
      const lineup = byWeek.get(week);
      const stats = statsByWeekPlayer.get(week)?.get(playerId);
      const { gamePlayed, participated, evidenceAvailable } = participationFlags(stats);

      const isBye = teamCode !== null && !teamsWithGameByWeek.get(week)?.has(teamCode);
      const scheduledGame = teamCode !== null ? !isBye : null;

      // IR: only asserted for the trailing block of weeks after this
      // player's last real participation, and only if the season-end
      // snapshot actually lists them on reserve — see module docstring.
      const isTrailingUnproductive =
        lastParticipatedWeek === null ? true : week > lastParticipatedWeek;
      const isIr =
        seasonEndReserve.has(playerId) && isTrailingUnproductive && gamePlayed !== true;

      let cls: AvailabilityClass;
      if (isIr) cls = "ir";
      else if (isBye) cls = "bye";
      else if (gamePlayed === true) cls = "participated";
      else if (gamePlayed === false) cls = "did_not_play_unknown";
      else cls = "unknown";

      weekly.push({ week, cls, lineup });

      const teamSample = teamSampleSizeByWeek.get(week) ?? 0;
      const byeConfidence: AvailabilityConfidence = teamSample >= 16 ? "high" : "moderate";

      let confidence: AvailabilityConfidence;
      let reason: string;
      let granularity: EvidenceGranularity;
      const evidenceSources: string[] = [];
      const evidenceFlags: string[] = [];

      if (lineup) evidenceSources.push("sleeper_matchups");
      if (evidenceAvailable) evidenceSources.push("sleeper_weekly_stats");
      if (teamCode !== null) evidenceSources.push("sleeper_player_index_team");

      switch (cls) {
        case "ir":
          confidence = "low";
          granularity = "season_end_snapshot";
          reason =
            "Season-end roster snapshot lists this player on Reserve/IR, and no participation was recorded from this week through the end of the resolved season. The exact week of placement is not knowable from Sleeper's public API — only the trailing window is inferred.";
          evidenceSources.push("sleeper_rosters_snapshot");
          evidenceFlags.push("season_end_reserve");
          break;
        case "bye":
          confidence = byeConfidence;
          granularity = "weekly";
          reason =
            "No NFL team-defense stat row for this player's team recorded a game (gp>=1) in Sleeper's weekly stats dump for this week, indicating a bye week.";
          evidenceFlags.push("team_bye");
          break;
        case "participated":
          confidence = "high";
          granularity = "weekly";
          reason = "Sleeper's weekly stats endpoint recorded gp>=1 for this player-week.";
          evidenceFlags.push("has_stat_line", "team_played");
          break;
        case "did_not_play_unknown":
          confidence = "moderate";
          granularity = "weekly";
          reason =
            "Sleeper recorded a stat line for this player-week with gp=0 (the team had a game), but the specific reason the player did not participate is not available from Sleeper's public API.";
          evidenceFlags.push("has_stat_line", "team_played", "zero_gp");
          break;
        case "unknown":
        default:
          confidence = "low";
          granularity = "unknown";
          reason =
            "No participation stat line, bye signal, or reserve status was found for this player-week.";
          break;
      }

      const rowStarterPoints =
        matchupsByWeek
          .get(week)
          ?.find((m) => m.roster_id === lineup?.roster_id)
          ?.players_points?.[playerId] ?? null;

      records.push({
        league_selector: leagueSelector,
        league_id: leagueId,
        season,
        week,
        player_id: playerId,
        player_name: player.full_name,
        position: player.position,
        nfl_team: teamCode,

        manager_id: lineup?.user_id ?? null,
        roster_id: lineup?.roster_id ?? null,

        rostered: lineup !== undefined,
        started: lineup?.is_starter ?? false,
        bench: lineup ? !lineup.is_starter : false,
        reserve_or_ir: isIr ? true : lineup !== undefined ? false : null,

        scheduled_game: scheduledGame,
        bye_week: teamCode !== null ? isBye : null,

        game_played: gamePlayed,
        player_participated: participated,
        snap_or_participation_evidence_available: evidenceAvailable,

        historical_injury_designation_raw: null,
        historical_injury_designation: null,
        historical_game_status: null,
        historical_practice_status: null,

        inactive: null,
        official_inactive_evidence: null,

        suspended: null,
        pup: null,
        nfi: null,
        reserve_status: isIr ? "IR (season_end_snapshot)" : null,
        other_unavailability_status: null,

        fantasy_points: typeof rowStarterPoints === "number" ? rowStarterPoints : null,

        availability_class: cls,
        availability_reason: reason,
        availability_confidence: confidence,

        evidence_sources: evidenceSources,
        evidence_flags: evidenceFlags,
        evidence_granularity: granularity,

        // Filled in below, once every week's lineup is known for this player.
        started_previous_week: null,
        starts_prior_3_weeks: null,
        rostered_previous_week: null,

        consecutive_games_missed_before_week: null,
        consecutive_weeks_unavailable_before_week: null,
        returning_after_absence: null,
        first_game_back: null,

        known_before_transaction: null,

        resolved: player.resolved,
      });
    }

    // Second pass: fill Phase 12 (prior-use) and Phase 19 (continuity) fields,
    // which depend on the player's own preceding weeks within the same run.
    const recordsForPlayer = records.slice(records.length - weekly.length);
    let missedStreak = 0;
    for (let i = 0; i < recordsForPlayer.length; i += 1) {
      const week = sortedWeeks[i];
      const priorWeek = sortedWeeks[i - 1];
      const record = recordsForPlayer[i];
      if (!record) continue;

      if (priorWeek !== undefined) {
        const priorLineup = byWeek.get(priorWeek);
        record.started_previous_week = priorLineup ? priorLineup.is_starter : false;
        record.rostered_previous_week = priorLineup !== undefined;
      }

      const priorThree = sortedWeeks.slice(Math.max(0, i - 3), i);
      if (priorThree.length > 0) {
        record.starts_prior_3_weeks = priorThree.filter(
          (w) => byWeek.get(w)?.is_starter === true,
        ).length;
      }

      const missedThisWeek = record.availability_class !== "participated";
      record.consecutive_games_missed_before_week = missedStreak;
      record.consecutive_weeks_unavailable_before_week = missedStreak;
      record.returning_after_absence = missedStreak > 0 && !missedThisWeek;
      record.first_game_back = record.returning_after_absence;
      missedStreak = missedThisWeek ? missedStreak + 1 : 0;

      void week; // week already embedded in `record`; kept for readability
    }
  }

  records.sort(
    (a, b) => a.week - b.week || a.player_id.localeCompare(b.player_id),
  );

  const coverage: AvailabilityCoverage = {
    total_player_weeks: records.length,
    player_weeks_with_participation_evidence: records.filter(
      (r) => r.game_played !== null,
    ).length,
    player_weeks_with_injury_evidence: 0,
    player_weeks_with_inactive_evidence: 0,
    player_weeks_with_reserve_evidence: records.filter((r) => r.reserve_or_ir === true).length,
    player_weeks_with_practice_evidence: 0,
    unknown_player_weeks: records.filter((r) => r.availability_class === "unknown").length,
    by_confidence: { high: 0, moderate: 0, low: 0 },
    by_class: { participated: 0, bye: 0, ir: 0, did_not_play_unknown: 0, unknown: 0 },
  };
  for (const record of records) {
    coverage.by_confidence[record.availability_confidence] += 1;
    coverage.by_class[record.availability_class] += 1;
  }

  return { records, coverage, unresolvedPlayerIds: [...unresolved].sort() };
}
