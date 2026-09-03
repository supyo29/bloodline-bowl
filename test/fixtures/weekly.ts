/**
 * Synthetic canonical fixtures for the weekly decision engines — no network.
 */

import { CANONICAL_SCHEMA_VERSION } from "../../lib/canonical/schema";
import type {
  CanonicalPlayer,
  CanonicalPosition,
  CanonicalRoster,
} from "../../lib/canonical/schema";
import type {
  RosterConstraints,
  WeeklyProjection,
  WeeklyProjectionBatch,
} from "../../lib/weekly/schema";

export function player(
  id: string,
  position: CanonicalPosition,
  opts: { eligible?: CanonicalPosition[]; team?: string; name?: string; injury?: string | null } = {},
): CanonicalPlayer {
  return {
    canonical_player_id: id,
    full_name: opts.name ?? id,
    first_name: null,
    last_name: null,
    position,
    eligible_positions: opts.eligible ?? [position],
    nfl_team: opts.team ?? "KC",
    is_team_defense: position === "DEF",
    status: null,
    injury_status: opts.injury ?? null,
    identifiers: { sleeper_id: id.replace(/\D/g, "") || id },
    resolution: { method: "stable_id", confidence: "high", note: null },
  };
}

export function proj(
  id: string,
  position: string,
  points: number | null,
  opts: Partial<WeeklyProjection> = {},
): WeeklyProjection {
  const sd = points != null ? points * 0.4 : null;
  return {
    canonical_player_id: id,
    week: 1,
    season: 2026,
    position,
    nfl_team: "KC",
    opponent: "LV",
    is_home: null,
    projected_points: points,
    floor_points: points != null && sd != null ? Math.max(0, points - 0.84 * sd) : null,
    ceiling_points: points != null && sd != null ? points + 0.84 * sd : null,
    std_dev: sd,
    projection_status: opts.projection_status ?? (points == null ? "unavailable" : "projected"),
    expected_availability: opts.expected_availability ?? 1,
    is_bye: opts.is_bye ?? false,
    injury_status: opts.injury_status ?? null,
    rest_of_season_points: opts.rest_of_season_points ?? (points != null ? points * 12 : null),
    ros:
      opts.ros ??
      (points != null
        ? {
            points: opts.rest_of_season_points ?? points * 12,
            source: "test",
            external_season_points: points * 17,
            ri_season_points: null,
            ri_position_rank: null,
            ri_vor: null,
            ri_tier: null,
            ri_confidence: null,
            disagreement_pct: null,
            disagreement_direction: "ONE_SOURCE" as const,
            confidence: "MEDIUM" as const,
            warnings: [],
          }
        : null),
    source: "test",
    model_version: "test",
    uncertainty_source: "position_volatility_heuristic",
    warnings: [],
    ...opts,
  };
}

export function batch(
  projections: WeeklyProjection[],
  players: CanonicalPlayer[],
  status: WeeklyProjectionBatch["status"] = "READY",
): WeeklyProjectionBatch {
  return {
    league_slug: "test-league",
    season: 2026,
    week: 1,
    status,
    by_player: new Map(projections.map((p) => [p.canonical_player_id, p])),
    resolved_players: new Map(players.map((p) => [p.canonical_player_id, p])),
    source: "test",
    model_version: "test",
    missing: [],
    teams_with_games: ["KC", "LV", "SF", "MIN", "DAL", "BUF", "BAL", "PHI"],
    warnings: [],
  };
}

export function roster(
  teamId: string,
  starters: string[],
  bench: string[] = [],
  opts: { ir?: string[]; taxi?: string[]; startingSlots?: string[] } = {},
): CanonicalRoster {
  const slots = opts.startingSlots ?? ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const all = [...new Set([...starters, ...bench, ...(opts.ir ?? []), ...(opts.taxi ?? [])])];
  return {
    canonical_roster_id: teamId.replace("team:", "roster:"),
    canonical_team_id: teamId,
    slots: [
      ...slots.map((slot, i) => ({
        slot,
        slot_index: i,
        canonical_player_id: starters[i] ?? null,
        is_empty: starters[i] == null,
      })),
      ...bench.map((id, i) => ({ slot: "BN", slot_index: slots.length + i, canonical_player_id: id, is_empty: false })),
      ...(opts.ir ?? []).map((id, i) => ({ slot: "IR", slot_index: 100 + i, canonical_player_id: id, is_empty: false })),
    ],
    starters: starters.filter(Boolean),
    bench,
    ir: opts.ir ?? [],
    taxi: opts.taxi ?? [],
    all_players: all,
    provenance: { provider: "sleeper", provider_id: teamId, provider_synced_at: null },
  };
}

export const STD_CONSTRAINTS: RosterConstraints = {
  starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"],
  slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
  bench_slots: 5,
  ir_slots: 1,
  taxi_slots: 0,
  roster_size_limit: 15,
  active_roster_capacity: 14,
  reserve_ir_capacity: 1,
  taxi_capacity: 0,
  flex_positions: ["RB", "WR", "TE"],
  flex_slots: 1,
};

export const SUPERFLEX_CONSTRAINTS: RosterConstraints = {
  starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "SUPER_FLEX", "K", "DEF"],
  slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, SUPER_FLEX: 1, K: 1, DEF: 1 },
  bench_slots: 6,
  ir_slots: 1,
  taxi_slots: 0,
  roster_size_limit: 16,
  active_roster_capacity: 15,
  reserve_ir_capacity: 1,
  taxi_capacity: 0,
  flex_positions: ["QB", "RB", "WR", "TE"],
  flex_slots: 1,
};

export { CANONICAL_SCHEMA_VERSION };

/* ---- a fully-assembled synthetic WeeklyTeamContext (no network) ---- */

import { WEEKLY_ENGINE_VERSION } from "../../lib/weekly/schema";
import { buildLeagueAvailability } from "../../lib/weekly/availability";
import { computeWeeklyReplacement } from "../../lib/weekly/replacement";
import type {
  CanonicalFantasyTeam,
  CanonicalManager,
  CanonicalLeagueSnapshot,
} from "../../lib/canonical/schema";
import type { WeeklyTeamContext } from "../../lib/weekly/schema";

function team(id: string, mgrId: string): CanonicalFantasyTeam {
  return {
    canonical_team_id: id,
    canonical_league_id: "league:test-league",
    provider_team_id: id.split(":").pop() ?? id,
    team_name: id,
    canonical_manager_ids: [mgrId],
    record: { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 },
    faab_remaining: 100,
    waiver_priority: 5,
    provenance: { provider: "sleeper", provider_id: id, provider_synced_at: null },
  };
}
function mgr(id: string, slug: string): CanonicalManager {
  return {
    canonical_manager_id: id,
    manager_slug: slug,
    provider_username: slug,
    display_name: slug,
    provider_user_id: id.split(":").pop() ?? id,
    is_commissioner: false,
    is_co_manager: false,
    provenance: { provider: "sleeper", provider_id: id, provider_synced_at: null },
  };
}

export interface WeeklyContextFixture {
  league_slug?: string;
  week?: number;
  constraints?: RosterConstraints;
  team_count?: number;
  myRoster: CanonicalRoster;
  oppRoster?: CanonicalRoster | null;
  players: CanonicalPlayer[];
  projections: WeeklyProjection[];
  freeAgents?: CanonicalPlayer[];
  faProjections?: WeeklyProjection[];
  raw_scoring?: Record<string, number>;
  waiver_settings?: CanonicalLeagueSnapshot["league"]["waiver_settings"];
}

export function weeklyContext(f: WeeklyContextFixture): WeeklyTeamContext {
  const leagueSlug = f.league_slug ?? "test-league";
  const week = f.week ?? 1;
  const constraints = f.constraints ?? STD_CONSTRAINTS;
  const teamCount = f.team_count ?? 12;

  const myTeam = team(`team:${leagueSlug}:1`, `manager:${leagueSlug}:m1`);
  const oppTeam = f.oppRoster ? team(`team:${leagueSlug}:2`, `manager:${leagueSlug}:m2`) : null;
  const manager = mgr(`manager:${leagueSlug}:m1`, "m1");

  const allPlayers = [...f.players, ...(f.freeAgents ?? [])];
  const allProjs = [...f.projections, ...(f.faProjections ?? [])];
  const projBatch = batch(allProjs, allPlayers);

  const rosters = [f.myRoster, ...(f.oppRoster ? [f.oppRoster] : [])];
  const snapshot: CanonicalLeagueSnapshot = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: null,
    league: {
      canonical_league_id: `league:${leagueSlug}`,
      league_slug: leagueSlug,
      name: leagueSlug,
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: teamCount,
      current_week: week,
      scoring_rules: [],
      raw_scoring: f.raw_scoring ?? { rec: 1, pass_td: 4, rush_td: 6, rec_td: 6, pass_yd: 0.04, rush_yd: 0.1, rec_yd: 0.1 },
      roster_settings: {
        starting_slots: constraints.starting_slots,
        bench_slots: constraints.bench_slots,
        ir_slots: constraints.ir_slots,
        taxi_slots: constraints.taxi_slots,
        slot_requirements: constraints.slot_requirements,
      },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: f.waiver_settings ?? { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: leagueSlug, provider_synced_at: null },
    },
    season: 2026,
    week,
    managers: [manager],
    teams: [myTeam, ...(oppTeam ? [oppTeam] : [])],
    rosters,
    standings: [],
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: allPlayers,
    unresolved_players: [],
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };

  const startablePositions = new Set(
    constraints.starting_slots.flatMap((s) => (["QB", "RB", "WR", "TE", "K", "DEF"].includes(s) ? [s] : constraints.flex_positions)),
  );
  const availability = buildLeagueAvailability({
    snapshot,
    manager_team_id: myTeam.canonical_team_id,
    week,
    candidates: allPlayers,
    startable_positions: startablePositions,
  });
  const replacement = computeWeeklyReplacement({
    league_slug: leagueSlug,
    week,
    team_count: teamCount,
    constraints,
    projections: projBatch,
    availability,
  });

  const byId = new Map(allPlayers.map((p) => [p.canonical_player_id, p]));
  const lk = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is CanonicalPlayer => Boolean(p));

  return {
    engine_version: WEEKLY_ENGINE_VERSION,
    generated_at: new Date().toISOString(),
    league: {
      slug: leagueSlug,
      name: leagueSlug,
      provider: "sleeper",
      season: 2026,
      week,
      scoring_rules: [],
      raw_scoring: snapshot.league.raw_scoring,
      roster_constraints: constraints,
      waiver_settings: snapshot.league.waiver_settings,
    },
    manager,
    fantasy_team: myTeam,
    standing: null,
    roster: f.myRoster,
    starters: lk(f.myRoster.starters),
    bench: lk(f.myRoster.bench),
    reserve_ir: lk(f.myRoster.ir),
    taxi: lk(f.myRoster.taxi),
    all_rostered: lk(f.myRoster.all_players),
    opponent: oppTeam && f.oppRoster
      ? {
          fantasy_team: oppTeam,
          manager_ids: oppTeam.canonical_manager_ids,
          roster: f.oppRoster,
          starters: lk(f.oppRoster.starters),
          all_rostered: lk(f.oppRoster.all_players),
        }
      : null,
    projections: projBatch,
    replacement,
    availability,
    ros_signal: { status: "UNAVAILABLE", ri_model_version: null, external_source: "test", players_with_ri: 0, players_with_disagreement: 0 },
    byes: { bye_status: "VERIFIED", schedule_source: "test", by_player: {}, starters_on_bye_this_week: [], teams_on_bye: [] },
    positional_needs: [],
    status: "READY",
    persistence_status: "READY",
    data_quality: {
      projections: projBatch.status,
      roster_players_projected: f.myRoster.all_players.length,
      roster_players_total: f.myRoster.all_players.length,
      identity_unresolved: 0,
      opponent_available: Boolean(oppTeam),
    },
    warnings: [],
  };
}

