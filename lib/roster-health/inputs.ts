/**
 * Phase 6 — shared league-wide input adapter.
 *
 * ONE canonical league-state read, ONE weekly projection batch (all rostered
 * players), ONE RI season signal, ONE schedule read, ONE availability + weekly
 * replacement computation. Every per-team roster-health calc reuses these —
 * 0 additional provider reads per manager (spec §22, §30).
 *
 * Reuses the exact production plumbing (`buildCanonicalLeagueState`,
 * `getWeeklyProjectionProvider`, `assembleRosSignals`, `buildLeagueAvailability`,
 * `computeWeeklyReplacement`) — no second projection or replacement model.
 */

import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";
import { getWeeklyProjectionProvider } from "@/lib/weekly/projections/registry";
import { getScheduleProvider } from "@/lib/weekly/schedule/registry";
import { RosterIntelSeasonSignalProvider } from "@/lib/weekly/projections-ri";
import { assembleRosSignals } from "@/lib/weekly/ros";
import { buildLeagueAvailability } from "@/lib/weekly/availability";
import { computeWeeklyReplacement, DEFAULT_FRONTIER } from "@/lib/weekly/replacement";
import { isFlexSlot, FLEX_ELIGIBILITY } from "@/lib/weekly/slots";
import type {
  CanonicalLeagueSnapshot,
  CanonicalPlayer,
  CanonicalRoster,
} from "@/lib/canonical/schema";
import type {
  RosterConstraints,
  WeeklyProjectionBatch,
  WeeklyReplacement,
  LeagueAvailability,
} from "@/lib/weekly/schema";

const REGULAR_SEASON_WEEKS = 17;
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

export interface RosterHealthInputs {
  league_slug: string;
  season: number;
  week: number;
  provider: string;
  snapshot: CanonicalLeagueSnapshot;
  constraints: RosterConstraints;
  playerById: Map<string, CanonicalPlayer>;
  rosters: CanonicalRoster[];
  /** weekly projection batch — `wp.projected_points` weekly, `wp.ros.points` ROS. */
  weekly: WeeklyProjectionBatch;
  weeklyReplacement: WeeklyReplacement;
  /** ROS points per canonical id (external season prorated; league-theoretical). */
  rosPointsByCid: Map<string, number | null>;
  /** ROS replacement level per base position + FLEX — RANK-THEORETICAL, always degraded. */
  rosReplacement: Record<string, number | null>;
  ri_model_version: string | null;
  ros_source: string;
  weeks_left_frac: number;
  schedule_ready: boolean;
  teams_on_bye: Set<string>;
  warnings: string[];
}

export interface RosterHealthInputOptions {
  projectionProviderOverride?: ReturnType<typeof getWeeklyProjectionProvider>;
  scheduleProviderOverride?: ReturnType<typeof getScheduleProvider>;
  skipRi?: boolean;
}

export async function buildRosterHealthInputs(
  leagueSlug: string,
  options: RosterHealthInputOptions = {},
): Promise<RosterHealthInputs> {
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) throw new Error(`roster-health: ${resolution.code ?? "league_unresolved"}`);
  const league = resolution.league;
  const crosswalk = defaultCrosswalkSource()
    ? new PlayerCrosswalk(defaultCrosswalkSource()!)
    : new PlayerCrosswalk(NoCrosswalk);
  const state = await buildCanonicalLeagueState(leagueSlug, {
    includeMatchups: true,
    crosswalkOverride: crosswalk,
  });
  if (!state.ok || !state.snapshot) {
    throw new Error(`roster-health: could not build canonical league state (${state.code ?? "unknown"})`);
  }
  const snap = state.snapshot;
  const week = snap.league.current_week ?? snap.week ?? 1;
  const season = snap.league.season;
  const warnings: string[] = [];

  const rs = snap.league.roster_settings;
  const flexPositions = uniq(rs.starting_slots.filter((s) => isFlexSlot(s)).flatMap((s) => FLEX_ELIGIBILITY[s] ?? []));
  const constraints: RosterConstraints = {
    starting_slots: rs.starting_slots,
    slot_requirements: rs.slot_requirements,
    bench_slots: rs.bench_slots,
    ir_slots: rs.ir_slots,
    taxi_slots: rs.taxi_slots,
    roster_size_limit: rs.starting_slots.length + rs.bench_slots + rs.ir_slots + rs.taxi_slots || null,
    active_roster_capacity: rs.starting_slots.length + rs.bench_slots,
    reserve_ir_capacity: rs.ir_slots,
    taxi_capacity: rs.taxi_slots,
    flex_positions: flexPositions.length ? flexPositions : ["RB", "WR", "TE"],
    flex_slots: rs.starting_slots.filter((s) => isFlexSlot(s)).length,
  };

  const playerById = new Map(snap.players.map((p) => [p.canonical_player_id, p]));
  const allRosteredIds = uniq(snap.rosters.flatMap((r) => r.all_players));

  const projProvider = options.projectionProviderOverride ?? getWeeklyProjectionProvider(league.provider);
  const weekly = await projProvider.getWeeklyProjections({
    league: {
      league_slug: league.league_slug,
      season,
      raw_scoring: snap.league.raw_scoring,
      scoring_rules: snap.league.scoring_rules,
    },
    week,
    crosswalk,
    canonical_player_ids: allRosteredIds,
    want_rest_of_season: true,
  });

  let ri_model_version: string | null = null;
  const weeksLeftFrac = Math.max(0, (REGULAR_SEASON_WEEKS - (week - 1)) / REGULAR_SEASON_WEEKS);
  if (!options.skipRi && weekly.by_player.size > 0) {
    const ri = await new RosterIntelSeasonSignalProvider()
      .getSeasonSignal({ league_slug: league.league_slug, league_id: league.external_league_id })
      .catch(() => ({ status: "UNAVAILABLE" as const, model_version: null, by_sleeper_id: new Map(), warning: null }));
    ri_model_version = ri.model_version ?? null;
    const rosMeta = assembleRosSignals(weekly, ri, week);
    for (const w of rosMeta.warnings) warnings.push(w);
  } else {
    // no RI — external prorated is still assembled by the provider (`wp.rest_of_season_points`)
    warnings.push("RI season signal skipped — ROS uses external prorated only");
  }

  const rosPointsByCid = new Map<string, number | null>();
  for (const wp of weekly.by_player.values()) {
    rosPointsByCid.set(wp.canonical_player_id, wp.ros?.points ?? wp.rest_of_season_points ?? null);
  }

  const schedule = await (options.scheduleProviderOverride ?? getScheduleProvider()).getWeekSchedule(season, week);
  const scheduleReady = schedule.status === "READY";
  const teamsOnBye = new Set<string>(scheduleReady ? [...schedule.teams_on_bye] : []);

  const startablePos = new Set<string>(
    rs.starting_slots.flatMap((s) => (isFlexSlot(s) ? (FLEX_ELIGIBILITY[s] ?? []) : [s])),
  );
  const availability: LeagueAvailability = buildLeagueAvailability({
    snapshot: snap,
    manager_team_id: snap.rosters[0]?.canonical_team_id ?? "",
    week,
    candidates: snap.players,
    startable_positions: startablePos,
  });

  const weeklyReplacement = computeWeeklyReplacement({
    league_slug: league.league_slug,
    week,
    team_count: snap.teams.length,
    constraints,
    projections: weekly,
    availability,
    frontier: DEFAULT_FRONTIER,
  });

  // ROS replacement — RANK-THEORETICAL from the full ROS pool. Always degraded
  // (spec §6 — no live ROS free-agent market).
  const rosReplacement = computeRosReplacementTheoretical(rosPointsByCid, playerById, constraints, snap.teams.length);

  return {
    league_slug: league.league_slug,
    season,
    week,
    provider: league.provider,
    snapshot: snap,
    constraints,
    playerById,
    rosters: snap.rosters,
    weekly,
    weeklyReplacement,
    rosPointsByCid,
    rosReplacement,
    ri_model_version,
    ros_source: "sleeper_season_rotowire_prorated",
    weeks_left_frac: weeksLeftFrac,
    schedule_ready: scheduleReady,
    teams_on_bye: teamsOnBye,
    warnings,
  };
}

const BASE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

function computeRosReplacementTheoretical(
  rosPointsByCid: Map<string, number | null>,
  playerById: Map<string, CanonicalPlayer>,
  constraints: RosterConstraints,
  teamCount: number,
): Record<string, number | null> {
  const byPos: Record<string, number[]> = {};
  for (const [cid, pts] of rosPointsByCid) {
    if (pts == null) continue;
    const pos = playerById.get(cid)?.position;
    if (!pos) continue;
    (byPos[pos] ??= []).push(pts);
  }
  const out: Record<string, number | null> = {};
  for (const pos of BASE_POSITIONS) {
    const arr = (byPos[pos] ?? []).sort((a, b) => b - a);
    const starters = (constraints.slot_requirements[pos] ?? 0) * teamCount;
    const flexShare = constraints.flex_positions.includes(pos)
      ? Math.round((constraints.flex_slots * teamCount) / constraints.flex_positions.length)
      : 0;
    const rank = starters + flexShare + Math.round(teamCount * 0.5);
    out[pos] = arr[Math.min(rank, arr.length - 1)] ?? null;
  }
  // FLEX replacement = max of the flex-eligible position lines
  out.FLEX =
    Math.max(...constraints.flex_positions.map((p) => out[p] ?? -Infinity)) === -Infinity
      ? null
      : Math.max(...constraints.flex_positions.map((p) => out[p] ?? 0));
  return out;
}
