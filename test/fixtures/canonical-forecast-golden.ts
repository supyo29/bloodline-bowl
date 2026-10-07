/**
 * W1.P1 golden production fixture. Drives the REAL `buildWeeklyTeamContext` (schedule bye override, missing-data handling,
 * snapshot-free provider path) over a roster that covers every case the canonical forecast must keep distinct.
 * Importable from a pre-change checkout (it only touches long-standing public APIs) so the SAME scenario can be run
 * before and after W1.P1 to prove production numbers did not move.
 */

import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "../../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../../lib/persistence";
import type { CanonicalLeagueStateBundle, FantasyProvider } from "../../lib/providers/types";
import { ok } from "../../lib/providers/types";
import type { ProjectionProvider } from "../../lib/weekly/projections/types";
import type { CanonicalPlayer } from "../../lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../../lib/weekly/schema";

export interface GoldenPlayer {
  id: string;
  pos: CanonicalPlayer["position"];
  team: string;
  /** undefined => no feed entry at all */
  row?: { points: number | null; injury?: string | null; availability?: number; status?: WeeklyProjection["projection_status"]; warnings?: string[] };
  ids: CanonicalPlayer["identifiers"];
  note: string;
}

export const GOLDEN: GoldenPlayer[] = [
  { id: "g-qb", pos: "QB", team: "KC", row: { points: 22.4 }, ids: { sleeper_id: "g-qb" }, note: "healthy QB" },
  { id: "g-rb-q", pos: "RB", team: "KC", row: { points: 14.6, injury: "Questionable", availability: 0.78 }, ids: { sleeper_id: "g-rb-q" }, note: "questionable RB" },
  { id: "g-wr-out", pos: "WR", team: "KC", row: { points: 9.1, injury: "Out", availability: 0.03 }, ids: { sleeper_id: "g-wr-out" }, note: "injured (Out) WR with a source projection" },
  { id: "g-te-zero", pos: "TE", team: "KC", row: { points: 0 }, ids: { sleeper_id: "g-te-zero" }, note: "known zero projection (real stat line scoring to 0)" },
  { id: "g-k", pos: "K", team: "KC", row: { points: 8.2, warnings: ["k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)"] }, ids: { sleeper_id: "g-k" }, note: "kicker, standard-points fallback" },
  { id: "g-rb-bye", pos: "RB", team: "BUF", row: { points: 12 }, ids: { sleeper_id: "g-rb-bye" }, note: "BYE player with a stale feed entry" },
  { id: "g-def-bye", pos: "DEF", team: "BUF", ids: { sleeper_id: "BUF" }, note: "BYE team defense, no feed entry" },
  { id: "g-wr-missing", pos: "WR", team: "MIA", ids: { sleeper_id: "g-wr-missing" }, note: "playing team, absent from feed (unknown, never 0)" },
  { id: "g-rb-totals", pos: "RB", team: "MIA", row: { points: null, status: "unavailable", warnings: ["only_precomputed_totals (no reconstructable component stats for this league's scoring)"] }, ids: { sleeper_id: "g-rb-totals" }, note: "provider row with only precomputed totals" },
  { id: "g-te-yahoo", pos: "TE", team: "SF", row: { points: 7.7 }, ids: { yahoo_player_key: "nfl.p.40001", yahoo_id: "40001" }, note: "Yahoo-identified player: NO sleeper_id" },
  { id: "g-def", pos: "DEF", team: "SF", row: { points: 6, warnings: ["k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)"] }, ids: { sleeper_id: "SF" }, note: "playing DST, standard-points fallback" },
  { id: "g-rb-out-src", pos: "RB", team: "SF", row: { points: null, status: "out", warnings: [] }, ids: { sleeper_id: "g-rb-out-src" }, note: "source says gp=0 (out)" },
];

const BY_ID = new Map(GOLDEN.map((g) => [g.id, g]));
export const GOLDEN_IDS = GOLDEN.map((g) => g.id);

function mkPlayer(g: GoldenPlayer): CanonicalPlayer {
  return {
    canonical_player_id: g.id,
    full_name: g.id,
    first_name: null,
    last_name: null,
    position: g.pos,
    eligible_positions: [g.pos],
    nfl_team: g.team,
    is_team_defense: g.pos === "DEF",
    status: null,
    injury_status: g.row?.injury ?? null,
    identifiers: g.ids,
    resolution: { method: "stable_id", confidence: "high", note: null },
  };
}

function provider(): FantasyProvider {
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const starterIds = ["g-qb", "g-rb-q", "g-rb-bye", "g-wr-out", "g-wr-missing", "g-te-zero", "g-rb-totals", "g-k", "g-def-bye"];
  const bench = GOLDEN_IDS.filter((id) => !starterIds.includes(id));
  const roster1 = {
    canonical_roster_id: "roster:bloodline-bowl:1",
    canonical_team_id: "team:bloodline-bowl:1",
    slots: slots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: starterIds[i]!, is_empty: false })),
    starters: starterIds,
    bench,
    ir: [],
    taxi: [],
    all_players: [...starterIds, ...bench],
    provenance: { provider: "sleeper" as const, provider_id: "1", provider_synced_at: null },
  };
  const roster2 = { ...roster1, canonical_roster_id: "roster:bloodline-bowl:2", canonical_team_id: "team:bloodline-bowl:2", slots: [], starters: [], bench: [], all_players: [], provenance: { provider: "sleeper" as const, provider_id: "2", provider_synced_at: null } };
  const mgr = (user: string, mslug: string) => ({ canonical_manager_id: `manager:bloodline-bowl:${user}`, manager_slug: mslug, provider_username: mslug, display_name: mslug, provider_user_id: user, is_commissioner: false, is_co_manager: false, provenance: { provider: "sleeper" as const, provider_id: user, provider_synced_at: null } });
  const team = (n: number, user: string) => ({ canonical_team_id: `team:bloodline-bowl:${n}`, canonical_league_id: "league:bloodline-bowl", provider_team_id: String(n), team_name: `team ${n}`, canonical_manager_ids: [`manager:bloodline-bowl:${user}`], record: { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 }, faab_remaining: 90, waiver_priority: n, provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null } });
  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: "league:bloodline-bowl",
      league_slug: "bloodline-bowl",
      name: "bloodline-bowl",
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 2,
      current_week: 5,
      scoring_rules: [{ key: "rec", points: 0.5, category: "receiving" }],
      raw_scoring: { rec: 0.5, pass_td: 4, rec_td: 6, rush_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 },
      roster_settings: { starting_slots: slots, bench_slots: 8, ir_slots: 1, taxi_slots: 0, slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "bloodline-bowl", provider_synced_at: null },
    },
    managers: [mgr("u-supyo", "supyo29"), mgr("u-biji", "BijiMac")],
    teams: [team(1, "u-supyo"), team(2, "u-biji")],
    rosters: [roster1, roster2],
    standings: [],
    draft_picks: [],
    players: GOLDEN.map(mkPlayer),
    unresolved_players: [],
  };
  return {
    name: "sleeper",
    authentication: "NONE",
    capabilities: () => ({ league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true, transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: "2026-01-01T00:00:00.000Z" }),
    getLeagueState: async () => ok(bundle),
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: "league:bloodline-bowl", league_slug: "bloodline-bowl", players: [], provenance: { provider: "sleeper", provider_id: "bloodline-bowl", provider_synced_at: null } }),
  } satisfies FantasyProvider;
}

export function goldenProjectionProvider(canonicalSnapshot?: WeeklyProjectionBatch["canonical_snapshot"]): ProjectionProvider {
  return {
    name: "sleeper_weekly",
    model_version: "sleeper-weekly-rotowire",
    async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
      const by_player = new Map<string, WeeklyProjection>();
      const resolved_players = new Map<string, CanonicalPlayer>();
      for (const cid of req.canonical_player_ids) {
        const g = BY_ID.get(cid);
        if (!g?.row) continue;
        resolved_players.set(cid, mkPlayer(g));
        by_player.set(cid, {
          canonical_player_id: cid,
          week: req.week,
          season: 2026,
          position: g.pos,
          nfl_team: g.team,
          opponent: "OPP",
          is_home: null,
          projected_points: g.row.points,
          floor_points: g.row.points == null ? null : Math.max(0, g.row.points - 5),
          ceiling_points: g.row.points == null ? null : g.row.points + 8,
          std_dev: g.row.points == null ? null : 4,
          projection_status: g.row.status ?? "projected",
          expected_availability: g.row.availability ?? 1,
          is_bye: false,
          injury_status: g.row.injury ?? null,
          rest_of_season_points: null,
          ros: null,
          source: "sleeper_weekly",
          model_version: "sleeper-weekly-rotowire",
          uncertainty_source: "position_volatility_heuristic",
          warnings: g.row.warnings ?? [],
        });
      }
      return {
        league_slug: req.league.league_slug,
        season: 2026,
        week: req.week,
        status: "PROJECTIONS_PARTIAL",
        by_player,
        resolved_players,
        source: "sleeper_weekly",
        model_version: "sleeper-weekly-rotowire",
        missing: req.canonical_player_ids.filter((c) => !by_player.has(c)),
        teams_with_games: ["KC", "MIA", "SF", "OPP"],
        warnings: [],
        ...(canonicalSnapshot ? { canonical_snapshot: canonicalSnapshot } : {}),
      };
    },
  };
}

const schedule = {
  name: "fake-schedule",
  async getWeekSchedule(season: number, week: number) {
    return {
      season, week, status: "READY" as const, source: "fake-schedule",
      teams_with_games: new Set(["KC", "MIA", "SF"]),
      teams_on_bye: new Set<string>(["BUF"]),
      opponent_by_team: {},
      warnings: [],
    };
  },
};

export async function buildGoldenContext(canonicalSnapshot?: WeeklyProjectionBatch["canonical_snapshot"]) {
  setPersistence(memoryPersistence());
  const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
    week: 5,
    providerOverride: provider(),
    projectionProviderOverride: goldenProjectionProvider(canonicalSnapshot),
    scheduleProviderOverride: schedule,
    riSeasonProviderOverride: null,
    crosswalkOverride: new PlayerCrosswalk(NoCrosswalk),
    skipReturnGameEnrichment: true,
  });
  if (!r.context) throw new Error(`golden context failed: ${r.code} ${r.detail}`);
  return r.context;
}

/** The production-facing numbers every consumer reads today. This is the value compared before vs after W1.P1. */
export function productionNumbers(ctx: Awaited<ReturnType<typeof buildGoldenContext>>): Record<string, { projected_points: number | null; projection_status: string; expected_availability: number | null; is_bye: boolean | null }> {
  const out: Record<string, { projected_points: number | null; projection_status: string; expected_availability: number | null; is_bye: boolean | null }> = {};
  for (const id of [...GOLDEN_IDS].sort()) {
    const p = ctx.projections.by_player.get(id);
    out[id] = p
      ? { projected_points: p.projected_points, projection_status: p.projection_status, expected_availability: p.expected_availability, is_bye: p.is_bye }
      : { projected_points: null, projection_status: "NO_ROW", expected_availability: null, is_bye: null };
  }
  return out;
}
