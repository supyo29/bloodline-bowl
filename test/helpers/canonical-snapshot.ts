/**
 * Shared minimal CanonicalLeagueSnapshot builder for the bridge real-time-state
 * tests. Produces a v3 snapshot that passes the reconcile gate by default.
 */

import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
  type CanonicalPlayer,
  type CanonicalWarning,
} from "../../lib/canonical/schema";
import { ok, type FantasyProvider } from "../../lib/providers/types";

export const TEST_LEAGUE = "bloodline-bowl";
export const TEST_SEASON = 2026;

export function testPlayer(
  sleeperId: string,
  opts: { position?: string; unresolved?: boolean; team?: string | null } = {},
): CanonicalPlayer {
  const unresolved = opts.unresolved ?? false;
  return {
    canonical_player_id: `player:sleeper:${sleeperId}`,
    full_name: unresolved ? `Unknown (${sleeperId})` : `Player ${sleeperId}`,
    first_name: null,
    last_name: null,
    position: (opts.position ?? "WR") as CanonicalPlayer["position"],
    eligible_positions: [(opts.position ?? "WR") as CanonicalPlayer["position"]],
    nfl_team: opts.team ?? (unresolved ? null : "KC"),
    is_team_defense: (opts.position ?? "WR") === "DEF",
    status: null,
    injury_status: null,
    identifiers: { sleeper_id: sleeperId },
    resolution: unresolved
      ? { method: "unresolved", confidence: "none", note: "no crosswalk hit" }
      : { method: "stable_id", confidence: "exact", note: null },
  };
}

export interface MakeSnapshotOpts {
  week?: number;
  teams?: { roster_id: string; wins: number; losses: number; points_for?: number }[];
  standingsWinsOverride?: Record<string, number>;
  players?: CanonicalPlayer[];
  rosterPlayerIdsByTeam?: Record<string, string[]>;
  warnings?: CanonicalWarning[];
  live_provider_status?: CanonicalLeagueSnapshot["live_provider_status"];
  provider_synced_at?: string;
}

export function makeCanonicalSnapshot(opts: MakeSnapshotOpts = {}): CanonicalLeagueSnapshot {
  const L = TEST_LEAGUE;
  const week = opts.week ?? 3;
  const teamSpecs = opts.teams ?? [
    { roster_id: "1", wins: 2, losses: 1, points_for: 300 },
    { roster_id: "2", wins: 1, losses: 2, points_for: 250 },
  ];
  const synced = opts.provider_synced_at ?? new Date().toISOString();

  const teams = teamSpecs.map((t) => ({
    canonical_team_id: `team:${L}:${t.roster_id}`,
    canonical_league_id: `league:${L}`,
    provider_team_id: t.roster_id,
    team_name: `Team ${t.roster_id}`,
    canonical_manager_ids: [`manager:${L}:u${t.roster_id}`],
    provider_owner_id: `u${t.roster_id}`,
    record: { wins: t.wins, losses: t.losses, ties: 0, points_for: t.points_for ?? 0, points_against: 0 },
    faab_remaining: 100,
    waiver_priority: Number(t.roster_id),
    provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
  }));

  const rosters = teamSpecs.map((t) => {
    const ids = opts.rosterPlayerIdsByTeam?.[t.roster_id] ?? [];
    return {
      canonical_roster_id: `roster:${L}:${t.roster_id}`,
      canonical_team_id: `team:${L}:${t.roster_id}`,
      slots: [],
      starters: ids.slice(0, 1),
      bench: ids.slice(1),
      ir: [],
      taxi: [],
      all_players: ids,
      provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
    };
  });

  const standings = teamSpecs
    .map((t) => ({
      canonical_team_id: `team:${L}:${t.roster_id}`,
      rank: null as number | null,
      wins: opts.standingsWinsOverride?.[t.roster_id] ?? t.wins,
      losses: t.losses,
      ties: 0,
      win_percentage: null,
      points_for: t.points_for ?? 0,
      points_against: 0,
      games_played: t.wins + t.losses,
      playoff_seed: null,
    }))
    .sort((a, b) => b.wins - a.wins)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: synced,
    league: {
      canonical_league_id: `league:${L}`,
      league_slug: L,
      name: "Bloodline Bowl",
      season: TEST_SEASON,
      status: "in_season",
      sport: "nfl",
      team_count: teamSpecs.length,
      current_week: week,
      scoring_rules: [],
      raw_scoring: { rec: 1, pass_td: 4 },
      roster_settings: {
        starting_slots: ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"],
        bench_slots: 6,
        ir_slots: 1,
        taxi_slots: 0,
        slot_requirements: {},
      },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "x", provider_synced_at: null },
    },
    season: TEST_SEASON,
    week,
    managers: teamSpecs.map((t) => ({
      canonical_manager_id: `manager:${L}:u${t.roster_id}`,
      canonical_league_id: `league:${L}`,
      manager_slug: `u${t.roster_id}`,
      display_name: `Manager ${t.roster_id}`,
      provider_user_id: `u${t.roster_id}`,
      provider_username: `u${t.roster_id}`,
      is_commissioner: false,
      is_co_manager: false,
      provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
    })),
    teams,
    rosters,
    standings,
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: opts.players ?? [],
    unresolved_players: [],
    live_provider_status: opts.live_provider_status ?? "READY",
    history_persistence_status: "READY",
    warnings: opts.warnings ?? [],
  };
}

/**
 * A hermetic `FantasyProvider` that replays a fixed snapshot — for tests that
 * exercise the legacy / fallback branch without touching the network.
 */
export function stubProvider(snap: CanonicalLeagueSnapshot): FantasyProvider {
  const bundle = {
    league: snap.league,
    managers: snap.managers,
    teams: snap.teams,
    rosters: snap.rosters,
    standings: snap.standings,
    draft_picks: snap.draft_picks,
    players: snap.players,
    unresolved_players: snap.unresolved_players,
  };
  return {
    name: "sleeper",
    authentication: "NONE",
    capabilities: () => ({
      league: true, settings: true, managers: true, standings: true, rosters: true,
      matchups: true, transactions: true, players: true, free_agents: true, waivers: true,
      draft_results: true, live_authenticated_access: true,
    }),
    healthCheck: async () => ({
      provider: "sleeper", status: "READY", authentication: "NONE", detail: "", checked_at: new Date().toISOString(),
    }),
    getLeagueState: async () => ok(bundle),
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () =>
      ok({
        canonical_league_id: bundle.league.canonical_league_id,
        league_slug: bundle.league.league_slug,
        players: [],
        provenance: { provider: "sleeper", provider_id: null, provider_synced_at: null },
      }),
  };
}
